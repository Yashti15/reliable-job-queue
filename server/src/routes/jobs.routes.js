import mongoose from 'mongoose'
import { Router } from 'express'
import Job from '../models/job.model.js'
import { replayDeadJob } from '../queue/job-queue.js'
import { publishEvent, publishJobEvent } from '../realtime/event-publisher.js'
import JobAsset from '../models/job-asset.model.js'
import { fileStore } from '../storage/file-store.js'
import EmailQuota from '../models/email-quota.model.js'
import { getEmailPolicy, isAllowedEmailRecipient } from '../worker/email-policy.js'
import {
  validateEmailPayload,
  validateImagePayload,
  validatePdfPayload,
} from '../worker/job-payloads.js'
import { reserveEmailQuota } from '../worker/email-quota.js'
import QuotaReservation from '../models/quota-reservation.model.js'
import { reservePendingJobSlot } from '../worker/quota-reservation.js'

const jobStatuses = ['pending', 'processing', 'completed', 'failed', 'dead']
const priorities = ['low', 'normal', 'high']
const allowedCreateFields = new Set([
  'type',
  'payload',
  'priority',
  'runAt',
  'maxAttempts',
  'idempotencyKey',
])
const maxPageSize = 100

function escapeRegex(text) {
  return typeof text === 'string' ? text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : ''
}

function sendError(response, status, code, message, details) {
  response.status(status).json({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
  })
}

function invalidBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return 'Request body must be a JSON object.'
  }

  const unexpectedFields = Object.keys(body).filter(
    (field) => !allowedCreateFields.has(field),
  )
  if (unexpectedFields.length) {
    return `Unsupported field: ${unexpectedFields[0]}.`
  }

  if (typeof body.type !== 'string' || !body.type.trim()) {
    return 'type must be a non-empty string.'
  }
  if (
    body.type.trim().length > 200 ||
    body.payload === null ||
    typeof body.payload !== 'object' ||
    Array.isArray(body.payload)
  ) {
    return body.type.trim().length > 200
      ? 'type must be at most 200 characters.'
      : 'payload must be a JSON object.'
  }
  if (body.priority !== undefined && !priorities.includes(body.priority)) {
    return `priority must be one of: ${priorities.join(', ')}.`
  }
  if (
    body.maxAttempts !== undefined &&
    (!Number.isInteger(body.maxAttempts) || body.maxAttempts < 1)
  ) {
    return 'maxAttempts must be a positive integer.'
  }
  if (
    body.runAt !== undefined &&
    (typeof body.runAt !== 'string' || !Number.isFinite(Date.parse(body.runAt)))
  ) {
    return 'runAt must be a valid date.'
  }
  if (
    body.idempotencyKey !== undefined &&
    (typeof body.idempotencyKey !== 'string' ||
      !body.idempotencyKey.trim() ||
      body.idempotencyKey.trim().length > 200)
  ) {
    return 'idempotencyKey must be a non-empty string of at most 200 characters.'
  }

  return null
}

function handleUnexpectedError(response, error) {
  if (error?.name === 'ValidationError') {
    const details = Object.values(error.errors).map(({ path, message }) => ({
      field: path,
      message,
    }))
    sendError(response, 400, 'INVALID_JOB', 'Job validation failed.', details)
    return
  }

  if (error?.code === 11000 && error.keyPattern?.idempotencyKey) {
    sendError(
      response,
      409,
      'IDEMPOTENCY_KEY_CONFLICT',
      'A job with this idempotencyKey already exists.',
    )
    return
  }

  console.error(`Job API request failed (${error?.name ?? 'UnknownError'}).`)
  sendError(response, 500, 'INTERNAL_ERROR', 'The job request could not be completed.')
}

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined) {
    return defaultValue
  }
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    return null
  }

  const number = Number(value)
  return Number.isSafeInteger(number) ? number : null
}

export function getJobQuotaOptions(env = process.env) {
  const parseQuotaNumber = (value, defaultValue) => {
    if (value === undefined) return defaultValue
    const parsed = Number(value)
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultValue
  }
  return {
    maxPendingJobs: parseQuotaNumber(env.USER_MAX_PENDING_JOBS, 50),
  }
}

export function createJobsRouter(
  JobModel = Job,
  {
    eventPublisher = JobModel === Job ? publishEvent : async () => true,
    AssetModel = JobAsset,
    store = fileStore,
    EmailQuotaModel = EmailQuota,
    emailPolicyProvider = getEmailPolicy,
    now = () => new Date(),
    quotaOptions = getJobQuotaOptions(),
    ReservationModel = QuotaReservation,
  } = {},
) {
  const router = Router()

  async function prepareEmailReservation(request, response) {
    if (request.body?.type?.trim() !== 'send_email') return null

    let payload
    try {
      payload = validateEmailPayload(request.body.payload)
    } catch (error) {
      sendError(response, 400, 'INVALID_EMAIL_PAYLOAD', error.message)
      return false
    }

    const policy = emailPolicyProvider()
    if (!policy.enabled) {
      sendError(
        response,
        503,
        'EMAIL_SENDING_DISABLED',
        'Email sending is disabled or not safely configured.',
      )
      return false
    }
    if (!isAllowedEmailRecipient(payload.to, policy.allowedRecipients)) {
      sendError(
        response,
        403,
        'EMAIL_RECIPIENT_NOT_ALLOWED',
        'The recipient is not permitted by the server email allowlist.',
      )
      return false
    }

    try {
      const reservation = await reserveEmailQuota({
        ownerId: request.authUser._id,
        policy,
        now: now(),
        QuotaModel: EmailQuotaModel,
      })
      if (!reservation.allowed) {
        const message =
          reservation.code === 'EMAIL_RATE_LIMITED'
            ? 'Too many email jobs for this account; try again in the next minute.'
            : 'The configured email quota has been reached.'
        sendError(response, 429, reservation.code, message)
        return false
      }
      return reservation
    } catch (error) {
      console.error(`Email quota reservation failed (${error?.name ?? 'UnknownError'}).`)
      sendError(
        response,
        503,
        'EMAIL_QUOTA_UNAVAILABLE',
        'Email job capacity could not be verified; try again later.',
      )
      return false
    }
  }

  router.post('/', async (request, response) => {
    const bodyError = invalidBody(request.body)
    if (bodyError) {
      sendError(response, 400, 'INVALID_REQUEST', bodyError)
      return
    }

    let pendingJobReservation = null
    const maxPendingJobs = quotaOptions.maxPendingJobs ?? 50
    try {
      const reservation = await reservePendingJobSlot({
        ownerId: request.authUser._id,
        maxPendingJobs,
        JobModel,
        ReservationModel,
        now: now(),
      })
      if (!reservation.allowed) {
        sendError(
          response,
          429,
          reservation.code || 'JOB_QUOTA_EXCEEDED',
          reservation.message ||
            `Pending job limit of ${maxPendingJobs} reached for this account. Wait for pending jobs to complete before submitting more.`,
        )
        return
      }
      pendingJobReservation = reservation
    } catch (quotaError) {
      console.error(
        `Pending job quota check failed (${quotaError?.name ?? 'UnknownError'}).`,
      )
    }

    const jobType = request.body.type.trim()
    if (jobType === 'generate_pdf') {
      try {
        validatePdfPayload(request.body.payload)
      } catch (error) {
        if (pendingJobReservation?.release) {
          await pendingJobReservation.release()
        }
        sendError(response, 400, 'INVALID_PDF_PAYLOAD', error.message)
        return
      }
    } else if (jobType === 'process_image') {
      let imagePayload
      try {
        imagePayload = validateImagePayload(request.body.payload)
      } catch (error) {
        if (pendingJobReservation?.release) {
          await pendingJobReservation.release()
        }
        sendError(response, 400, 'INVALID_IMAGE_PAYLOAD', error.message)
        return
      }
      try {
        const uploadAsset = await AssetModel.findOne({
          _id: imagePayload.assetId,
          ownerId: request.authUser._id,
          kind: 'upload',
        })
        const assetExists = uploadAsset?.lean
          ? await uploadAsset.lean()
          : uploadAsset
        if (!assetExists) {
          if (pendingJobReservation?.release) {
            await pendingJobReservation.release()
          }
          sendError(
            response,
            400,
            'INVALID_IMAGE_ASSET',
            'The specified uploaded image asset was not found for this account.',
          )
          return
        }
      } catch (assetError) {
        if (pendingJobReservation?.release) {
          await pendingJobReservation.release()
        }
        sendError(
          response,
          400,
          'INVALID_IMAGE_ASSET',
          'The specified uploaded image asset was not found for this account.',
        )
        return
      }
    }

    if (
      jobType === 'send_email' &&
      request.body.maxAttempts !== undefined &&
      request.body.maxAttempts > 3
    ) {
      if (pendingJobReservation?.release) {
        await pendingJobReservation.release()
      }
      sendError(
        response,
        400,
        'EMAIL_ATTEMPTS_LIMIT_EXCEEDED',
        'Email jobs may be configured for at most 3 attempts.',
      )
      return
    }

    let quotaReservation = await prepareEmailReservation(request, response)
    if (quotaReservation === false) {
      if (pendingJobReservation?.release) {
        await pendingJobReservation.release()
      }
      return
    }

    const jobData = {
      ownerId: request.authUser._id,
      type: request.body.type.trim(),
      payload: request.body.payload,
      ...(request.body.priority !== undefined
        ? { priority: request.body.priority }
        : {}),
      ...(request.body.runAt !== undefined
        ? { runAt: new Date(request.body.runAt) }
        : {}),
      ...(request.body.maxAttempts !== undefined
        ? { maxAttempts: request.body.maxAttempts }
        : {}),
      ...(request.body.idempotencyKey !== undefined
        ? { idempotencyKey: request.body.idempotencyKey.trim() }
        : {}),
    }

    try {
      const job = await new JobModel(jobData).save()
      if (pendingJobReservation?.release) {
        await pendingJobReservation.release()
        pendingJobReservation = null
      }
      quotaReservation = null
      await publishJobEvent('job:created', job, eventPublisher)
      response.status(201).json({ success: true, data: { job } })
    } catch (error) {
      if (pendingJobReservation?.release) {
        try {
          await pendingJobReservation.release()
        } catch (releaseError) {
          console.error(
            `Pending job quota rollback failed (${releaseError?.name ?? 'UnknownError'}).`,
          )
        }
      }
      if (quotaReservation?.release) {
        try {
          await quotaReservation.release()
        } catch (releaseError) {
          console.error(
            `Email quota rollback failed (${releaseError?.name ?? 'UnknownError'}).`,
          )
        }
      }
      handleUnexpectedError(response, error)
    }
  })

  router.get('/', async (request, response) => {
    const page = parsePositiveInteger(request.query.page, 1)
    const limit = parsePositiveInteger(request.query.limit, 20)
    if (
      page === null ||
      limit === null ||
      limit > maxPageSize ||
      page > Math.floor(Number.MAX_SAFE_INTEGER / limit)
    ) {
      sendError(
        response,
        400,
        'INVALID_PAGINATION',
        `page must be a positive integer and limit must be between 1 and ${maxPageSize}.`,
      )
      return
    }

    const { status, type, priority, q, startDate, endDate } = request.query
    if (status !== undefined && !jobStatuses.includes(status)) {
      sendError(
        response,
        400,
        'INVALID_STATUS',
        `status must be one of: ${jobStatuses.join(', ')}.`,
      )
      return
    }

    if (priority !== undefined && !priorities.includes(priority)) {
      sendError(
        response,
        400,
        'INVALID_PRIORITY',
        `priority must be one of: ${priorities.join(', ')}.`,
      )
      return
    }

    let createdAtFilter
    if (startDate !== undefined) {
      const parsedStart = Date.parse(startDate)
      if (!Number.isFinite(parsedStart)) {
        sendError(response, 400, 'INVALID_DATE', 'startDate must be a valid date.')
        return
      }
      createdAtFilter = { ...createdAtFilter, $gte: new Date(parsedStart) }
    }
    if (endDate !== undefined) {
      const parsedEnd = Date.parse(endDate)
      if (!Number.isFinite(parsedEnd)) {
        sendError(response, 400, 'INVALID_DATE', 'endDate must be a valid date.')
        return
      }
      createdAtFilter = { ...createdAtFilter, $lte: new Date(parsedEnd) }
    }

    const filter = {
      ownerId: request.authUser._id,
      ...(status ? { status } : {}),
      ...(type && typeof type === 'string' && type.trim() ? { type: type.trim() } : {}),
      ...(priority ? { priority } : {}),
      ...(createdAtFilter ? { createdAt: createdAtFilter } : {}),
    }

    if (q && typeof q === 'string' && q.trim()) {
      const search = q.trim().slice(0, 100)
      const isObjectId = mongoose.isObjectIdOrHexString(search)
      const regex = new RegExp(escapeRegex(search), 'i')
      if (isObjectId) {
        filter.$or = [
          { _id: new mongoose.Types.ObjectId(search) },
          { idempotencyKey: search },
          { type: regex },
        ]
      } else {
        filter.$or = [
          { idempotencyKey: regex },
          { type: regex },
        ]
      }
    }
    try {
      const [jobs, total] = await Promise.all([
        JobModel.find(filter)
          .sort({ createdAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        JobModel.countDocuments(filter),
      ])
      response.json({
        success: true,
        data: {
          jobs,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      })
    } catch (error) {
      handleUnexpectedError(response, error)
    }
  })

  router.get('/dead', async (request, response) => {
    const page = parsePositiveInteger(request.query.page, 1)
    const limit = parsePositiveInteger(request.query.limit, 20)
    if (
      page === null ||
      limit === null ||
      limit > maxPageSize ||
      page > Math.floor(Number.MAX_SAFE_INTEGER / limit)
    ) {
      sendError(
        response,
        400,
        'INVALID_PAGINATION',
        `page must be a positive integer and limit must be between 1 and ${maxPageSize}.`,
      )
      return
    }

    try {
      const filter = { ownerId: request.authUser._id, status: 'dead' }
      const [jobs, total] = await Promise.all([
        JobModel.find(filter)
          .sort({ deadAt: -1, _id: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .lean(),
        JobModel.countDocuments(filter),
      ])
      response.json({
        success: true,
        data: {
          jobs,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      })
    } catch (error) {
      handleUnexpectedError(response, error)
    }
  })

  router.post('/:id/replay', async (request, response) => {
    const { id } = request.params
    let quotaReservation = null
    if (!mongoose.isObjectIdOrHexString(id)) {
      sendError(response, 400, 'INVALID_JOB_ID', 'id must be a valid MongoDB ObjectId.')
      return
    }

    if (
      request.body !== undefined &&
      (!request.body ||
        typeof request.body !== 'object' ||
        Array.isArray(request.body) ||
        Object.keys(request.body).some((field) => field !== 'runAt'))
    ) {
      sendError(response, 400, 'INVALID_REQUEST', 'Replay body may contain only runAt.')
      return
    }

    const now = new Date()
    let runAt = now
    if (request.body?.runAt !== undefined) {
      const parsedRunAt =
        typeof request.body.runAt === 'string' ? Date.parse(request.body.runAt) : NaN
      if (!Number.isFinite(parsedRunAt) || parsedRunAt <= now.getTime()) {
        sendError(response, 400, 'INVALID_RUN_AT', 'runAt must be a valid future date.')
        return
      }
      runAt = new Date(parsedRunAt)
    }

    try {
      const existingJob = await JobModel.findOne({
        _id: id,
        ownerId: request.authUser._id,
      }).lean()
      if (!existingJob) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Job was not found.')
        return
      }
      if (existingJob.status !== 'dead') {
        sendError(response, 409, 'JOB_NOT_REPLAYABLE', 'Only dead jobs can be replayed.')
        return
      }

      const replayRequest = {
        authUser: request.authUser,
        body: { type: existingJob.type, payload: existingJob.payload },
      }
      quotaReservation = await prepareEmailReservation(replayRequest, response)
      if (quotaReservation === false) return

      const job = await replayDeadJob(
        existingJob,
        { now, runAt, ownerId: request.authUser._id },
        JobModel,
      )
      if (!job) {
        await quotaReservation?.release?.()
        quotaReservation = null
        sendError(
          response,
          409,
          'JOB_NOT_REPLAYABLE',
          'The job was already replayed or its dead-letter state changed.',
        )
        return
      }

      quotaReservation = null
      await publishJobEvent('job:replayed', job, eventPublisher)
      response.json({ success: true, data: { replayed: true, job } })
    } catch (error) {
      if (quotaReservation?.release) {
        try {
          await quotaReservation.release()
        } catch (releaseError) {
          console.error(
            `Email quota rollback failed (${releaseError?.name ?? 'UnknownError'}).`,
          )
        }
      }
      handleUnexpectedError(response, error)
    }
  })

  router.post('/:id/retry', async (request, response) => {
    const { id } = request.params
    if (!mongoose.isObjectIdOrHexString(id)) {
      sendError(response, 400, 'INVALID_JOB_ID', 'id must be a valid MongoDB ObjectId.')
      return
    }

    try {
      const existingJob = await JobModel.findOne({
        _id: id,
        ownerId: request.authUser._id,
      }).lean()
      if (!existingJob) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Job was not found.')
        return
      }

      if (['pending', 'processing'].includes(existingJob.status)) {
        sendError(
          response,
          409,
          'JOB_NOT_RETRYABLE',
          'Only non-active jobs (failed, dead, or completed) can be retried.',
        )
        return
      }

      const retryTime = new Date()
      let runAt = retryTime
      if (request.body?.runAt !== undefined) {
        const parsed = typeof request.body.runAt === 'string' ? Date.parse(request.body.runAt) : NaN
        if (Number.isFinite(parsed)) {
          runAt = new Date(parsed)
        }
      }

      const job = await JobModel.findOneAndUpdate(
        {
          _id: id,
          ownerId: request.authUser._id,
          status: { $nin: ['pending', 'processing'] },
        },
        {
          $set: {
            status: 'pending',
            attempts: 0,
            runAt,
          },
          $unset: {
            workerId: 1,
            claimToken: 1,
            claimedAt: 1,
            leaseExpiresAt: 1,
            completedAt: 1,
            deadAt: 1,
            progress: 1,
          },
          $push: {
            replayHistory: {
              replayedAt: retryTime,
              previousAttempts: existingJob.attempts ?? 0,
              previousLastError: existingJob.lastError || 'Manual retry requested by operator',
            },
          },
          $inc: { replayCount: 1 },
        },
        { new: true, runValidators: true },
      ).lean()

      if (!job) {
        sendError(response, 409, 'JOB_NOT_RETRYABLE', 'Job state changed concurrently.')
        return
      }

      await publishJobEvent('job:retried', job, eventPublisher)
      response.json({ success: true, data: { retried: true, job } })
    } catch (error) {
      handleUnexpectedError(response, error)
    }
  })

  router.get('/:jobId/artifacts/:artifactId', async (request, response) => {
    const { jobId, artifactId } = request.params
    if (
      !mongoose.isObjectIdOrHexString(jobId) ||
      !mongoose.isObjectIdOrHexString(artifactId)
    ) {
      sendError(response, 400, 'INVALID_ARTIFACT_ID', 'Job and artifact IDs must be valid ObjectIds.')
      return
    }

    try {
      const job = await JobModel.findOne({
        _id: jobId,
        ownerId: request.authUser._id,
        status: 'completed',
      }).lean()
      const isAttached =
        job?.result?.artifacts?.some(
          (artifact) => String(artifact.assetId) === artifactId,
        ) ?? false
      if (!job || !isAttached) {
        sendError(response, 404, 'ARTIFACT_NOT_FOUND', 'Artifact was not found.')
        return
      }

      const asset = await AssetModel.findOne({
        _id: artifactId,
        jobId,
        ownerId: request.authUser._id,
        kind: 'output',
      }).lean()
      if (!asset) {
        sendError(response, 404, 'ARTIFACT_NOT_FOUND', 'Artifact was not found.')
        return
      }

      const content = await store.load(asset.ownerId, asset.storageKey, 'outputs')
      response.set({
        'Content-Type': asset.mediaType,
        'Content-Length': content.length,
        'Content-Disposition': `${asset.mediaType.startsWith('image/')
          ? 'inline'
          : 'attachment'}; filename="${asset.fileName}"`,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
      })
      response.send(content)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        sendError(response, 404, 'ARTIFACT_NOT_FOUND', 'Artifact was not found.')
        return
      }
      console.error(`Artifact download failed (${error?.name ?? 'UnknownError'}).`)
      sendError(response, 500, 'ARTIFACT_DOWNLOAD_FAILED', 'Artifact could not be downloaded.')
    }
  })

  router.get('/:id', async (request, response) => {
    const { id } = request.params
    if (!mongoose.isObjectIdOrHexString(id)) {
      sendError(response, 400, 'INVALID_JOB_ID', 'id must be a valid MongoDB ObjectId.')
      return
    }

    try {
      const job = await JobModel.findOne({
        _id: id,
        ownerId: request.authUser._id,
      }).lean()
      if (!job) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Job was not found.')
        return
      }

      response.json({ success: true, data: { job } })
    } catch (error) {
      handleUnexpectedError(response, error)
    }
  })

  router.delete('/:id', async (request, response) => {
    const { id } = request.params
    if (!mongoose.isObjectIdOrHexString(id)) {
      sendError(response, 400, 'INVALID_JOB_ID', 'id must be a valid MongoDB ObjectId.')
      return
    }

    try {
      const job = await JobModel.findOneAndDelete({
        _id: id,
        status: 'pending',
        ownerId: request.authUser._id,
      }).lean()
      if (job) {
        await publishJobEvent('job:cancelled', job, eventPublisher)
        response.json({ success: true, data: { cancelled: true, job } })
        return
      }

      const existingJob = await JobModel.findOne({
        _id: id,
        ownerId: request.authUser._id,
      }).lean()
      if (!existingJob) {
        sendError(response, 404, 'JOB_NOT_FOUND', 'Job was not found.')
        return
      }

      sendError(
        response,
        409,
        'JOB_NOT_CANCELLABLE',
        'Only pending jobs can be cancelled.',
      )
    } catch (error) {
      handleUnexpectedError(response, error)
    }
  })

  return router
}

export default createJobsRouter()
