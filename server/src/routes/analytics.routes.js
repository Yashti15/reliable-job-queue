import { Router } from 'express'
import Job from '../models/job.model.js'

const periodDays = 30
const millisecondsPerDay = 24 * 60 * 60 * 1000

function sendError(response) {
  response.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: 'Analytics could not be loaded.',
    },
  })
}

export function calculateAnalytics(group = {}) {
  const completed = group.completed ?? 0
  const failed = group.failed ?? 0
  const dead = group.dead ?? 0
  const terminalTotal = completed + failed + dead
  const duration = group.averageExecutionDurationMs

  return {
    periodDays,
    jobs: {
      total: group.total ?? 0,
      pending: group.pending ?? 0,
      processing: group.processing ?? 0,
      completed,
      failed,
      dead,
    },
    terminal: {
      total: terminalTotal,
      successRate: terminalTotal ? roundPercentage((completed / terminalTotal) * 100) : 0,
      failureRate: terminalTotal ? roundPercentage(((failed + dead) / terminalTotal) * 100) : 0,
    },
    averageExecutionDurationMs:
      typeof duration === 'number' && Number.isFinite(duration)
        ? Math.round(duration)
        : null,
  }
}

function roundPercentage(value) {
  return Math.round(value * 10) / 10
}

export function createAnalyticsRouter(JobModel = Job, { now = () => new Date() } = {}) {
  const router = Router()

  router.get('/', async (request, response) => {
    const generatedAt = now()
    const from = new Date(generatedAt.getTime() - periodDays * millisecondsPerDay)
    try {
      const [group = {}] = await JobModel.aggregate([
        { $match: { ownerId: request.authUser._id, createdAt: { $gte: from } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
            processing: { $sum: { $cond: [{ $eq: ['$status', 'processing'] }, 1, 0] } },
            completed: { $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            dead: { $sum: { $cond: [{ $eq: ['$status', 'dead'] }, 1, 0] } },
            averageExecutionDurationMs: {
              $avg: {
                $cond: [
                  {
                    $and: [
                      { $eq: ['$status', 'completed'] },
                      { $ne: ['$claimedAt', null] },
                      { $ne: ['$completedAt', null] },
                    ],
                  },
                  { $subtract: ['$completedAt', '$claimedAt'] },
                  null,
                ],
              },
            },
          },
        },
      ])
      response.json({
        success: true,
        data: {
          ...calculateAnalytics(group),
          generatedAt,
          windowStart: from,
        },
      })
    } catch (error) {
      const name = error instanceof Error ? error.name : 'UnknownError'
      console.error(`Analytics request failed (${name}).`)
      sendError(response)
    }
  })

  return router
}

export default createAnalyticsRouter()
