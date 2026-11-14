import os from 'node:os'
import Worker from '../models/worker.model.js'
import { publishEvent } from '../realtime/event-publisher.js'

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

export async function startWorkerMonitor({
  workerId,
  heartbeatIntervalMs,
  WorkerModel = Worker,
  publish = publishEvent,
  logger = console,
  now = () => new Date(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  processId = process.pid,
  host = os.hostname(),
} = {}) {
  let timer
  let stopped = false
  let currentJob
  let lastOwnerId

  function workerEvent(status, lastSeenAt) {
    return {
      workerId,
      status,
      lastSeenAt,
      ...(currentJob
        ? {
            currentJobId: String(currentJob._id),
            currentJobType: currentJob.type,
          }
        : {}),
    }
  }

  async function updateCurrentJob(job) {
    const nextJob = job || undefined
    const nextOwnerId = nextJob ? nextJob.ownerId : lastOwnerId
    try {
      const lastSeenAt = now()
      const update = {
        $set: { lastSeenAt },
        $unset: { stoppedAt: 1 },
      }
      if (nextJob) {
        update.$set.currentJobId = String(nextJob._id)
        update.$set.currentJobType = nextJob.type
        if (nextOwnerId) update.$set.currentJobOwnerId = nextOwnerId
        else update.$unset.currentJobOwnerId = 1
      } else if (nextOwnerId) {
        update.$set.currentJobOwnerId = nextOwnerId
      } else {
        update.$unset.currentJobOwnerId = 1
      }
      if (!nextJob) {
        update.$unset.currentJobId = 1
        update.$unset.currentJobType = 1
      }
      const result = await WorkerModel.updateOne(
        { workerId, status: 'active' },
        update,
      )
      if (result.matchedCount) {
        currentJob = nextJob
        if (nextJob) lastOwnerId = nextJob.ownerId
        if (nextOwnerId) {
          await publish(
            'worker:updated',
            workerEvent('active', lastSeenAt),
            nextOwnerId,
          )
        }
      }
    } catch (error) {
      logger.error(`Worker status update failed (${safeErrorName(error)}).`)
    }
  }

  async function heartbeat() {
    if (stopped) return
    try {
      const lastSeenAt = now()
      const result = await WorkerModel.updateOne(
        { workerId, status: 'active' },
        { $set: { lastSeenAt } },
      )
      if (result.matchedCount) {
        if (lastOwnerId) {
          await publish(
            'worker:heartbeat',
            workerEvent('active', lastSeenAt),
            lastOwnerId,
          )
        }
      }
    } catch (error) {
      logger.error(`Worker heartbeat record failed (${safeErrorName(error)}).`)
    }
    if (!stopped) {
      timer = setTimeoutFn(() => void heartbeat(), heartbeatIntervalMs)
    }
  }

  const startedAt = now()
  await WorkerModel.findOneAndUpdate(
    { workerId },
    {
      $set: {
        status: 'active',
        lastSeenAt: startedAt,
        startedAt,
        processId,
        host,
      },
      $unset: {
        stoppedAt: 1,
        currentJobId: 1,
        currentJobType: 1,
        currentJobOwnerId: 1,
      },
    },
    { upsert: true, new: true, runValidators: true },
  )
  timer = setTimeoutFn(() => void heartbeat(), heartbeatIntervalMs)

  return {
    setCurrentJob: updateCurrentJob,
    async stop() {
      stopped = true
      if (timer) clearTimeoutFn(timer)
      const stoppedAt = now()
      try {
        const stoppedOwnerId = lastOwnerId
        const result = await WorkerModel.findOneAndUpdate(
          { workerId, status: 'active' },
          {
            $set: { status: 'stopped', stoppedAt, lastSeenAt: stoppedAt },
            $unset: {
              currentJobId: 1,
              currentJobType: 1,
            },
          },
          { new: true },
        ).lean()
        if (result) {
          currentJob = undefined
          if (stoppedOwnerId) {
            await publish(
              'worker:updated',
              { workerId, status: 'stopped', lastSeenAt: stoppedAt },
              stoppedOwnerId,
            )
          }
        }
      } catch (error) {
        logger.error(`Worker shutdown status update failed (${safeErrorName(error)}).`)
      }
    },
  }
}
