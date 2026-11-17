import { randomUUID } from 'node:crypto'
import * as jobQueue from '../queue/job-queue.js'
import { getJobHandler } from './job-handlers.js'

const defaultLogger = {
  info: (message, details) => console.log(message, details ?? ''),
  warn: (message, details) => console.warn(message, details ?? ''),
  error: (message, details) => console.error(message, details ?? ''),
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

export function createWorker({
  workerId = `worker-${randomUUID()}`,
  pollIntervalMs = 2000,
  queue = jobQueue,
  getHandler = getJobHandler,
  logger = defaultLogger,
  retryOptions,
  leaseDurationMs = 30_000,
  heartbeatIntervalMs = 10_000,
  onStateChange = async () => {},
  now = () => new Date(),
  monotonicNow = () => performance.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new RangeError('pollIntervalMs must be a positive integer.')
  }
  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new RangeError('leaseDurationMs must be a positive safe integer.')
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs < 1 ||
    heartbeatIntervalMs >= leaseDurationMs
  ) {
    throw new RangeError('heartbeatIntervalMs must be positive and shorter than leaseDurationMs.')
  }

  let stopping = false
  let sleepTimer
  let wakeSleep
  let runPromise

  async function reportState(job) {
    try {
      await onStateChange(job)
    } catch (error) {
      logger.error('Worker status could not be recorded.', {
        workerId,
        errorName: safeErrorName(error),
      })
    }
  }

  function startHeartbeat(job) {
    let stopped = false
    let timer
    let inFlight
    let leaseLost = false

    function scheduleHeartbeat() {
      timer = setTimeoutFn(() => {
        heartbeat().catch((error) => {
          leaseLost = true
          logger.error('Worker heartbeat loop failed; result will not be persisted.', {
            jobId: String(job._id),
            workerId,
            errorName: safeErrorName(error),
          })
        })
      }, heartbeatIntervalMs)
    }

    async function heartbeat() {
      if (stopped || leaseLost) {
        return
      }

      inFlight = (async () => {
        try {
          const renewedJob = await queue.renewLease(job, workerId, {
            now: now(),
            leaseDurationMs,
          })
          if (!renewedJob) {
            leaseLost = true
            logger.warn('Worker lost job lease; result will not be persisted.', {
              jobId: String(job._id),
              workerId,
            })
          }
        } catch (error) {
          leaseLost = true
          logger.error('Worker heartbeat failed; result will not be persisted.', {
            jobId: String(job._id),
            workerId,
            errorName: safeErrorName(error),
          })
        }
      })()

      await inFlight
      inFlight = undefined
      if (!stopped && !leaseLost) {
        scheduleHeartbeat()
      }
    }

    scheduleHeartbeat()

    return {
      get leaseLost() {
        return leaseLost
      },
      async stop() {
        stopped = true
        if (timer) {
          clearTimeoutFn(timer)
          timer = undefined
        }
        if (inFlight) {
          await inFlight
        }
      },
    }
  }

  async function processNextJob() {
    const job = await queue.claimNextJob(workerId, {
      now: now(),
      leaseDurationMs,
    })
    if (!job) {
      return false
    }

    await reportState(job)
    try {
      logger.info('Job claimed.', { jobId: String(job._id), workerId })

      let result
      let handlerError
      let handlerFailed = false
      const executionStartedAt = monotonicNow()
      const executionStartDate = now()
      const heartbeat = startHeartbeat(job)

      const reportProgress = async (progressData) => {
        if (typeof queue.updateJobProgress === 'function' && !heartbeat.leaseLost) {
          try {
            await queue.updateJobProgress(job, workerId, progressData, { now: now() })
          } catch (progressError) {
            logger.warn('Progress update could not be persisted.', {
              jobId: String(job._id),
              workerId,
              errorName: safeErrorName(progressError),
            })
          }
        }
      }

      try {
        const handler = getHandler(job.type)
        if (!handler) {
          const error = new Error('No handler is registered for this job type.')
          error.name = 'UnknownJobTypeError'
          throw error
        }

        result = await handler(job.payload, {
          jobId: String(job._id),
          workerId,
          job,
          logger,
          reportProgress,
        })
      } catch (error) {
        handlerFailed = true
        handlerError = error
      }
      const elapsedMs = monotonicNow() - executionStartedAt
      const executionDurationMs = Number.isFinite(elapsedMs)
        ? Math.max(0, Math.round(elapsedMs))
        : undefined

      await heartbeat.stop()
      if (heartbeat.leaseLost) {
        return true
      }

      const attemptInfo = {
        attempt: (job.attempts ?? 0) + 1,
        workerId,
        startedAt: executionStartDate,
        finishedAt: now(),
        durationMs: executionDurationMs,
        error: handlerFailed ? safeErrorName(handlerError) : undefined,
      }

      if (handlerFailed) {
        try {
          const failedJob = await queue.failJob(job, workerId, handlerError, {
            now: now(),
            retryOptions,
            attemptInfo,
          })
          if (!failedJob) {
            logger.warn('Job failure update rejected because worker ownership changed.', {
              jobId: String(job._id),
              workerId,
            })
          } else {
            logger.error('Job execution failed.', {
              jobId: String(job._id),
              workerId,
              errorName: safeErrorName(handlerError),
              ...(executionDurationMs !== undefined
                ? { executionDurationMs }
                : {}),
              attempts: failedJob.attempts,
              status: failedJob.status,
            })
          }
        } catch (updateError) {
          logger.error('Could not record job failure.', {
            jobId: String(job._id),
            workerId,
            errorName: safeErrorName(updateError),
          })
        }

        return true
      }

      try {
        const completedJob = await queue.completeJob(
          job,
          workerId,
          now(),
          undefined,
          result,
          { attemptInfo },
        )
        if (!completedJob) {
          logger.warn('Job completion rejected because worker ownership changed.', {
            jobId: String(job._id),
            workerId,
          })
          return true
        }

        logger.info('Job completed.', {
          jobId: String(job._id),
          workerId,
          resultType: typeof result?.type === 'string' ? result.type : 'success',
          ...(executionDurationMs !== undefined
            ? { executionDurationMs }
            : {}),
        })
      } catch (error) {
        logger.error('Could not record job completion.', {
          jobId: String(job._id),
          workerId,
          errorName: safeErrorName(error),
        })
      }

      return true
    } finally {
      await reportState(null)
    }
  }

  function waitForNextPoll() {
    return new Promise((resolve) => {
      wakeSleep = resolve
      sleepTimer = setTimeout(() => {
        sleepTimer = undefined
        wakeSleep = undefined
        resolve()
      }, pollIntervalMs)
    })
  }

  function run() {
    if (runPromise) {
      return runPromise
    }

    runPromise = (async () => {
      while (!stopping) {
        let jobWasClaimed = false
        try {
          jobWasClaimed = await processNextJob()
        } catch (error) {
          logger.error('Worker polling failed.', {
            workerId,
            errorName: safeErrorName(error),
          })
        }

        if (!jobWasClaimed && !stopping) {
          await waitForNextPoll()
        }
      }
    })()

    return runPromise
  }

  function stop() {
    stopping = true
    if (sleepTimer) {
      clearTimeout(sleepTimer)
      sleepTimer = undefined
      const resolve = wakeSleep
      wakeSleep = undefined
      resolve?.()
    }
  }

  return { workerId, processNextJob, run, stop }
}
