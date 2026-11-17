import Job from '../models/job.model.js'
import { randomUUID } from 'node:crypto'
import { calculateRetryDelay } from './retry-policy.js'
import { publishJobEvent } from '../realtime/event-publisher.js'
import { JobHandlerError } from '../errors/job-handler-error.js'

const priorities = ['high', 'normal', 'low']
const defaultLeaseDurationMs = 30_000

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

function makeLeaseUpdate(workerId, now, leaseDurationMs, claimToken) {
  return {
    $set: {
      status: 'processing',
      workerId,
      claimToken,
      claimedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseDurationMs),
    },
    $unset: { completedAt: 1 },
  }
}

export async function claimNextJob(
  workerId,
  options = {},
) {
  const {
    now = options instanceof Date ? options : new Date(),
    leaseDurationMs = defaultLeaseDurationMs,
    createClaimToken = randomUUID,
    eventPublisher,
  } = options instanceof Date ? {} : options

  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError('leaseDurationMs must be a positive safe integer.')
  }

  const exhaustedLeases = await Job.find({
    status: 'processing',
    ownerId: { $type: 'objectId' },
    leaseExpiresAt: { $lte: now },
    $expr: { $gte: [{ $add: ['$attempts', 1] }, '$maxAttempts'] },
  })
    .select({
      _id: 1,
      ownerId: 1,
      attempts: 1,
      maxAttempts: 1,
      leaseExpiresAt: 1,
    })
    .lean()
  for (const expiredJob of exhaustedLeases) {
    const deadJob = await Job.findOneAndUpdate(
      {
        _id: expiredJob._id,
        status: 'processing',
        ownerId: expiredJob.ownerId,
        attempts: expiredJob.attempts,
        maxAttempts: expiredJob.maxAttempts,
        leaseExpiresAt: expiredJob.leaseExpiresAt,
        $expr: { $gte: [{ $add: ['$attempts', 1] }, '$maxAttempts'] },
      },
      {
        $inc: { attempts: 1 },
        $set: {
          status: 'dead',
          deadAt: now,
          lastError: 'Job lease expired at the maximum attempt limit.',
        },
        $unset: {
          workerId: 1,
          claimToken: 1,
          claimedAt: 1,
          leaseExpiresAt: 1,
          completedAt: 1,
        },
      },
      { new: true, runValidators: true },
    ).lean()
    if (deadJob) {
      await publishJobEvent('job:dead', deadJob, eventPublisher)
    }
  }

  for (const priority of priorities) {
    const nowForClaim = now
    const claimToken = createClaimToken()
    const leaseUpdate = makeLeaseUpdate(workerId, nowForClaim, leaseDurationMs, claimToken)

    const reclaimedJob = await Job.findOneAndUpdate(
      {
        status: 'processing',
        ownerId: { $type: 'objectId' },
        priority,
        leaseExpiresAt: { $lte: nowForClaim },
        $expr: { $lt: [{ $add: ['$attempts', 1] }, '$maxAttempts'] },
      },
      {
        ...leaseUpdate,
        $inc: { attempts: 1 },
      },
      {
        new: true,
        runValidators: true,
        sort: { createdAt: 1, _id: 1 },
      },
    ).lean()

    if (reclaimedJob) {
      await publishJobEvent('job:claimed', reclaimedJob, eventPublisher)
      return reclaimedJob
    }

    const job = await Job.findOneAndUpdate(
      {
        status: 'pending',
        ownerId: { $type: 'objectId' },
        priority,
        runAt: { $lte: nowForClaim },
        $expr: { $lt: ['$attempts', '$maxAttempts'] },
      },
      leaseUpdate,
      {
        new: true,
        runValidators: true,
        sort: { createdAt: 1, _id: 1 },
      },
    ).lean()

    if (job) {
      await publishJobEvent('job:claimed', job, eventPublisher)
      return job
    }
  }

  return null
}

function ownedUnexpiredClaim(job, workerId, now) {
  return {
    _id: job._id,
    status: 'processing',
    ownerId: job.ownerId,
    workerId,
    claimToken: job.claimToken,
    leaseExpiresAt: { $gt: now },
  }
}

export function renewLease(
  job,
  workerId,
  {
    now = new Date(),
    leaseDurationMs = defaultLeaseDurationMs,
  } = {},
) {
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError('leaseDurationMs must be a positive safe integer.')
  }

  return Job.findOneAndUpdate(
    ownedUnexpiredClaim(job, workerId, now),
    { $set: { leaseExpiresAt: new Date(now.getTime() + leaseDurationMs) } },
    { new: true, runValidators: true },
  ).lean()
}

export function completeJob(
  job,
  workerId,
  completedAt = new Date(),
  eventPublisher,
  result,
  options = {},
) {
  const update = {
    $set: {
      status: 'completed',
      completedAt,
      ...(job.progress
        ? {
            'progress.percent': 100,
            'progress.stage': 'completed',
            'progress.message': 'Job execution completed successfully.',
            'progress.updatedAt': completedAt,
          }
        : {}),
    },
    $unset: { lastError: 1, claimToken: 1, leaseExpiresAt: 1 },
  }
  if (options?.attemptInfo) {
    update.$push = { attemptHistory: options.attemptInfo }
  }
  if (result !== undefined) {
    const safeResult = normalizeExecutionResult(result)
    if (safeResult !== undefined) update.$set.result = safeResult
  }

  return Job.findOneAndUpdate(
    ownedUnexpiredClaim(job, workerId, completedAt),
    update,
    { new: true, runValidators: true },
  )
    .lean()
    .then(async (completedJob) => {
      if (completedJob) {
        await publishJobEvent('job:completed', completedJob, eventPublisher)
      }
      return completedJob
    })
}

export async function updateJobProgress(
  job,
  workerId,
  progressData = {},
  { now = new Date(), eventPublisher } = {},
) {
  const percent =
    typeof progressData.percent === 'number' && Number.isFinite(progressData.percent)
      ? Math.max(0, Math.min(100, Math.round(progressData.percent)))
      : 0
  const stage = typeof progressData.stage === 'string' ? progressData.stage.slice(0, 100) : ''
  const message = typeof progressData.message === 'string' ? progressData.message.slice(0, 500) : ''

  const progress = {
    percent,
    stage,
    message,
    updatedAt: now,
  }

  const updatedJob = await Job.findOneAndUpdate(
    ownedUnexpiredClaim(job, workerId, now),
    { $set: { progress } },
    { new: true, runValidators: true },
  ).lean()

  if (updatedJob) {
    await publishJobEvent('job:progress', updatedJob, eventPublisher)
  }
  return updatedJob
}

export function failJob(
  job,
  workerId,
  error,
  {
    now = new Date(),
    retryOptions,
    random = Math.random,
    eventPublisher,
    attemptInfo,
  } = {},
) {
  const errorName = safeErrorName(error)
  const safeMessage =
    error instanceof JobHandlerError && error.message.length <= 500
      ? error.message
      : `Job processing failed (${errorName}).`
  const nextAttempts = job.attempts + 1
  const willRetry = nextAttempts < job.maxAttempts
  const nextRunAt = willRetry
    ? new Date(
        now.getTime() +
          calculateRetryDelay(nextAttempts, { ...retryOptions, random }),
      )
    : undefined

  const update = {
    $inc: { attempts: 1 },
    $set: {
      status: willRetry ? 'pending' : 'dead',
      lastError: safeMessage,
      ...(!willRetry ? { deadAt: now } : {}),
      ...(willRetry ? { runAt: nextRunAt } : {}),
    },
    $unset: {
      workerId: 1,
      claimToken: 1,
      claimedAt: 1,
      leaseExpiresAt: 1,
      completedAt: 1,
      result: 1,
      progress: 1,
      ...(willRetry ? { deadAt: 1 } : {}),
    },
  }
  if (attemptInfo) {
    update.$push = { attemptHistory: attemptInfo }
  }

  return Job.findOneAndUpdate(
    {
      ...ownedUnexpiredClaim(job, workerId, now),
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
    },
    update,
    { new: true, runValidators: true },
  )
    .lean()
    .then(async (updatedJob) => {
      if (updatedJob) {
        await publishJobEvent('job:failed', updatedJob, eventPublisher)
        if (updatedJob.status === 'dead') {
          await publishJobEvent('job:dead', updatedJob, eventPublisher)
        } else {
          await publishJobEvent('job:retried', updatedJob, eventPublisher)
        }
      }
      return updatedJob
    })
}

export function replayDeadJob(
  job,
  { now = new Date(), runAt = now, ownerId = job.ownerId } = {},
  JobModel = Job,
) {
  return JobModel.findOneAndUpdate(
    {
      _id: job._id,
      status: 'dead',
      ownerId,
      attempts: job.attempts,
      deadAt: job.deadAt,
    },
    {
      $set: {
        status: 'pending',
        attempts: 0,
        runAt,
      },
      $unset: {
        deadAt: 1,
        workerId: 1,
        claimToken: 1,
        claimedAt: 1,
        leaseExpiresAt: 1,
        completedAt: 1,
        result: 1,
      },
      $inc: { replayCount: 1 },
      $push: {
        replayHistory: {
          $each: [
            {
              replayedAt: now,
              previousAttempts: job.attempts,
              previousLastError: job.lastError,
            },
          ],
          $slice: -20,
        },
      },
    },
    { new: true, runValidators: true },
  ).lean()
}

function normalizeExecutionResult(result) {
  if (
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !['email', 'pdf', 'image'].includes(result.type)
  ) {
    return undefined
  }

  const serialized = JSON.stringify(result)
  if (serialized.length > 10_000) {
    throw new JobHandlerError('Handler result metadata exceeds the allowed size.', {
      name: 'InvalidJobResultError',
    })
  }

  const allowedFields = {
    email: ['type', 'provider', 'status', 'providerMessageId'],
    pdf: ['type', 'title', 'artifacts'],
    image: ['type', 'operation', 'width', 'height', 'format', 'artifacts'],
  }[result.type]
  if (Object.keys(result).some((field) => !allowedFields.includes(field))) {
    throw new JobHandlerError('Handler returned unsupported result metadata.', {
      name: 'InvalidJobResultError',
    })
  }

  const normalized = {}
  for (const field of allowedFields) {
    if (field !== 'artifacts' && result[field] !== undefined) {
      normalized[field] = result[field]
    }
    if (
      (result.type === 'email' &&
        (result.provider !== 'resend' ||
          result.status !== 'accepted' ||
          typeof result.providerMessageId !== 'string' ||
          result.providerMessageId.length > 200)) ||
      (result.type === 'pdf' &&
        (typeof result.title !== 'string' ||
          result.title.length > 160 ||
          !Array.isArray(result.artifacts) ||
          result.artifacts.length !== 1)) ||
      (result.type === 'image' &&
        (!['resize', 'convert', 'thumbnail'].includes(result.operation) ||
          !['jpeg', 'png', 'webp'].includes(result.format) ||
          !Number.isInteger(result.width) ||
          result.width < 1 ||
          result.width > 4000 ||
          !Number.isInteger(result.height) ||
          result.height < 1 ||
          result.height > 4000 ||
          !Array.isArray(result.artifacts) ||
          result.artifacts.length !== 1))
    ) {
      throw new JobHandlerError('Handler returned unsupported result metadata.', {
        name: 'InvalidJobResultError',
      })
    }
  }
  if (result.artifacts !== undefined) {
    if (!Array.isArray(result.artifacts) || result.artifacts.length > 4) {
      throw new JobHandlerError('Handler returned invalid artifact metadata.', {
        name: 'InvalidJobResultError',
      })
    }
    for (const artifact of result.artifacts) {
      if (
        !artifact ||
        typeof artifact.assetId !== 'string' ||
        !/^[0-9a-f]{24}$/i.test(artifact.assetId) ||
        typeof artifact.fileName !== 'string' ||
        !['report.pdf', 'processed.jpg', 'processed.png', 'processed.webp'].includes(
          artifact.fileName,
        ) ||
        !['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(
          artifact.mediaType,
        ) ||
        !Number.isSafeInteger(artifact.sizeBytes) ||
        artifact.sizeBytes < 1 ||
        artifact.sizeBytes > 10 * 1024 * 1024
      ) {
        throw new JobHandlerError('Handler returned invalid artifact metadata.', {
          name: 'InvalidJobResultError',
        })
      }
    }
    normalized.artifacts = result.artifacts.map((artifact) => ({
      assetId: artifact.assetId,
      fileName: artifact.fileName,
      mediaType: artifact.mediaType,
      sizeBytes: artifact.sizeBytes,
    }))
  }
  return normalized
}
