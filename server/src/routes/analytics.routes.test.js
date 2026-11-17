import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'
import { afterEach, test } from 'node:test'
import { calculateAnalytics, createAnalyticsRouter } from './analytics.routes.js'

let server
const testUserId = new mongoose.Types.ObjectId()

afterEach(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    server = undefined
  }
})

test('analytics handles empty datasets and zero terminal jobs', () => {
  assert.deepEqual(calculateAnalytics(), {
    periodDays: 30,
    jobs: {
      total: 0,
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      dead: 0,
    },
    terminal: { total: 0, successRate: 0, failureRate: 0 },
    averageExecutionDurationMs: null,
  })
})

test('analytics computes success and failure rates from terminal outcomes', () => {
  const analytics = calculateAnalytics({
    completed: 7,
    failed: 1,
    dead: 2,
    averageExecutionDurationMs: 1250.4,
  })

  assert.deepEqual(analytics.terminal, {
    total: 10,
    successRate: 70,
    failureRate: 30,
  })
  assert.equal(analytics.averageExecutionDurationMs, 1250)
})

test('analytics API applies its 30-day window and returns aggregation results', async () => {
  const generatedAt = new Date('2025-01-31T12:00:00.000Z')
  let pipeline
  const app = express()
  app.use('/api/analytics', (request, _response, next) => {
    request.authUser = { _id: testUserId }
    next()
  })
  app.use(
    '/api/analytics',
    createAnalyticsRouter(
      {
        async aggregate(value) {
          pipeline = value
          return [{ total: 10, completed: 8, failed: 1, dead: 1 }]
        },
      },
      { now: () => generatedAt },
    ),
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analytics`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.data.terminal.successRate, 80)
  assert.equal(result.data.terminal.failureRate, 20)
  assert.equal(
    pipeline[0].$match.createdAt.$gte.toISOString(),
    '2025-01-01T12:00:00.000Z',
  )
  assert.ok(pipeline[0].$match.ownerId.equals(testUserId))
})

test('analytics API returns byType, byPriority, and dailyTrend breakdown from facet', async () => {
  const generatedAt = new Date('2025-01-31T12:00:00.000Z')
  const facetResult = {
    overview: [{ total: 25, completed: 20, failed: 3, dead: 2, averageExecutionDurationMs: 1450 }],
    byType: [
      { _id: 'generate_pdf', count: 15 },
      { _id: 'process_image', count: 7 },
      { _id: 'send_email', count: 3 },
    ],
    byPriority: [
      { _id: 'normal', count: 18 },
      { _id: 'high', count: 5 },
      { _id: 'low', count: 2 },
    ],
    dailyTrend: [
      { _id: '2025-01-25', total: 5, completed: 4, failed: 1 },
      { _id: '2025-01-26', total: 8, completed: 7, failed: 1 },
    ],
  }

  const app = express()
  app.use('/api/analytics', (req, res, next) => {
    req.authUser = { _id: testUserId }
    next()
  })
  app.use(
    '/api/analytics',
    createAnalyticsRouter(
      {
        async aggregate() {
          return [facetResult]
        },
      },
      { now: () => generatedAt },
    ),
  )

  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analytics`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.data.jobs.total, 25)
  assert.equal(result.data.jobs.completed, 20)
  assert.equal(result.data.byType.length, 3)
  assert.equal(result.data.byType[0].type, 'generate_pdf')
  assert.equal(result.data.byType[0].count, 15)
  assert.equal(result.data.byPriority.length, 3)
  assert.equal(result.data.dailyTrend.length, 2)
})
