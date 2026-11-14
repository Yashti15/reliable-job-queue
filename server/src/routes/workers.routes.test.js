import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'
import { afterEach, test } from 'node:test'
import { createWorkersRouter } from './workers.routes.js'

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

test('worker API distinguishes active, idle, unresponsive, and stopped workers', async () => {
  const now = new Date('2025-03-01T12:00:00.000Z')
  const records = [
    { workerId: 'running', status: 'active', currentJobOwnerId: testUserId, lastSeenAt: new Date(now - 100), currentJobId: 'job-1' },
    { workerId: 'idle', status: 'active', currentJobOwnerId: testUserId, lastSeenAt: new Date(now - 100) },
    { workerId: 'stale', status: 'active', currentJobOwnerId: testUserId, lastSeenAt: new Date(now - 2000), currentJobId: 'job-2' },
    { workerId: 'stopped', status: 'stopped', currentJobOwnerId: testUserId, lastSeenAt: new Date(now - 100) },
  ]
  const WorkerModel = {
    find(filter) {
      assert.ok(filter.currentJobOwnerId.equals(testUserId))
      const query = {
        sort() { return query },
        limit() { return query },
        async lean() {
          return records.filter((worker) =>
            worker.currentJobOwnerId.equals(filter.currentJobOwnerId),
          )
        },
      }
      return query
    },
  }
  const app = express()
  app.use('/api/workers', (request, _response, next) => {
    request.authUser = { _id: testUserId }
    next()
  })
  app.use(
    '/api/workers',
    createWorkersRouter(WorkerModel, { now: () => now, staleAfterMs: 1000 }),
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/workers`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.deepEqual(
    result.data.workers.map(({ workerId, state }) => [workerId, state]),
    [
      ['running', 'active'],
      ['idle', 'idle'],
      ['stale', 'unresponsive'],
      ['stopped', 'disconnected'],
    ],
  )
  assert.deepEqual(result.data.counts, {
    active: 1,
    idle: 1,
    unresponsive: 1,
    disconnected: 1,
    total: 4,
  })
})
