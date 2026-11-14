import { Router } from 'express'
import Worker from '../models/worker.model.js'

function getStaleAfterMs() {
  const interval = process.env.WORKER_HEARTBEAT_INTERVAL_MS
  if (!interval || !/^[1-9]\d*$/.test(interval)) return 30_000
  const value = Number(interval)
  return Number.isSafeInteger(value) ? value * 3 : 30_000
}

function sendError(response) {
  response.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Worker status could not be loaded.',
    },
  })
}

export function createWorkersRouter(
  WorkerModel = Worker,
  { now = () => new Date(), staleAfterMs: configuredStaleAfterMs } = {},
) {
  const router = Router()

  router.get('/', async (request, response) => {
    const checkedAt = now()
    const staleAfterMs = configuredStaleAfterMs ?? getStaleAfterMs()
    try {
      const records = await WorkerModel.find({
        currentJobOwnerId: request.authUser._id,
      })
        .sort({ lastSeenAt: -1 })
        .limit(100)
        .lean()
      const workers = records.map((worker) => {
        let state = 'disconnected'
        if (worker.status === 'active') {
          state =
            checkedAt.getTime() - new Date(worker.lastSeenAt).getTime() > staleAfterMs
              ? 'unresponsive'
              : worker.currentJobId
                ? 'active'
                : 'idle'
        }
        return {
          workerId: worker.workerId,
          state,
          lastSeenAt: worker.lastSeenAt,
          startedAt: worker.startedAt,
          ...(worker.stoppedAt ? { stoppedAt: worker.stoppedAt } : {}),
          ...(worker.currentJobId
            ? {
                currentJobId: worker.currentJobId,
                currentJobType: worker.currentJobType,
              }
            : {}),
        }
      })
      response.json({
        success: true,
        data: {
          workers,
          counts: {
            active: workers.filter((worker) => worker.state === 'active').length,
            idle: workers.filter((worker) => worker.state === 'idle').length,
            unresponsive: workers.filter((worker) => worker.state === 'unresponsive').length,
            disconnected: workers.filter((worker) => worker.state === 'disconnected').length,
            total: workers.length,
          },
          checkedAt,
          staleAfterMs,
        },
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError'
      console.error(`Worker status request failed (${name}).`)
      sendError(response)
    }
  })

  return router
}

export default createWorkersRouter()
