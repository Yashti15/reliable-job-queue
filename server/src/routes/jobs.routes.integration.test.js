import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import Job from '../models/job.model.js'
import QueueEvent from '../models/queue-event.model.js'
import { claimNextJob, completeJob, failJob } from '../queue/job-queue.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import { createJobsRouter } from './jobs.routes.js'

const testUri = process.env.MONGODB_TEST_URI
const testOwnerId = new mongoose.Types.ObjectId()

describe(
  'MongoDB job idempotency and dead-job replay integration',
  { skip: testUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  () => {
    let closeTestDatabase
    let server
    let baseUrl

    before(async () => {
      closeTestDatabase = await connectToIsolatedMongoTestDatabase()
      await Job.init()
      await QueueEvent.init()
      const create = Job.create.bind(Job)
      Job.create = (data, options) =>
        create({ ownerId: testOwnerId, ...data }, options)
    })

    beforeEach(async () => {
      await Job.deleteMany({})
      await QueueEvent.deleteMany({})
      const app = express()
      app.use(express.json())
      app.use('/api/jobs', (request, _response, next) => {
        request.authUser = { _id: testOwnerId }
        next()
      })
      app.use('/api/jobs', createJobsRouter(Job))
      server = app.listen(0)
      await new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      baseUrl = `http://127.0.0.1:${server.address().port}`
    })

    afterEach(async () => {
      if (server) {
        await new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()))
        })
        server = undefined
      }
    })

    after(async () => {
      Job.create = mongoose.Model.create.bind(Job)
      if (closeTestDatabase) {
        await closeTestDatabase()
      }
    })

    test('concurrent creation requests with one idempotency key create one job', async () => {
      const body = {
        type: 'test',
        payload: { to: 'learner@example.test', subject: 'Idempotent request' },
        idempotencyKey: 'integration-concurrent-create',
      }
      const responses = await Promise.all([
        fetch(`${baseUrl}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        fetch(`${baseUrl}/api/jobs`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ])

      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [201, 409],
      )
      assert.equal(await Job.countDocuments({ idempotencyKey: body.idempotencyKey }), 1)
      assert.equal(await QueueEvent.countDocuments({ name: 'job:created' }), 1)
    })

    test('concurrent replay requests produce exactly one replay transition', async () => {
      const job = await Job.create({
        type: 'test',
        payload: { to: 'learner@example.test' },
        status: 'dead',
        attempts: 3,
        maxAttempts: 3,
        deadAt: new Date(),
        lastError: 'Job processing failed (TypeError).',
      })
      const url = `${baseUrl}/api/jobs/${job._id}/replay`
      const responses = await Promise.all([
        fetch(url, { method: 'POST' }),
        fetch(url, { method: 'POST' }),
      ])

      assert.deepEqual(
        responses.map((response) => response.status).sort(),
        [200, 409],
      )
      const replayed = await Job.findById(job._id).lean()
      assert.equal(replayed.status, 'pending')
      assert.equal(replayed.attempts, 0)
      assert.equal(replayed.replayCount, 1)
      assert.equal(replayed.replayHistory.length, 1)
      assert.equal(await QueueEvent.countDocuments({ name: 'job:replayed' }), 1)
    })

    test('replay retains the creation idempotency key without creating another job', async () => {
      const key = 'replay-keeps-original-key'
      const job = await Job.create({
        type: 'test',
        payload: { to: 'learner@example.test' },
        idempotencyKey: key,
        status: 'dead',
        attempts: 1,
        maxAttempts: 1,
        deadAt: new Date(),
        lastError: 'Job processing failed (Error).',
      })

      const replay = await fetch(`${baseUrl}/api/jobs/${job._id}/replay`, {
        method: 'POST',
      })
      assert.equal(replay.status, 200)
      assert.equal((await Job.findById(job._id).lean()).idempotencyKey, key)

      const duplicateCreation = await fetch(`${baseUrl}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'test',
          payload: { to: 'learner@example.test' },
          idempotencyKey: key,
        }),
      })
      assert.equal(duplicateCreation.status, 409)
      assert.equal(await Job.countDocuments({ idempotencyKey: key }), 1)
    })

    test('old worker cannot update a job after dead-letter replay and re-claim', async () => {
      const job = await Job.create({
        type: 'test',
        payload: { value: 'preserved' },
        maxAttempts: 1,
        idempotencyKey: 'stale-worker-replay',
      })
      const staleClaim = await claimNextJob('stale-worker')
      const dead = await failJob(staleClaim, 'stale-worker', new Error('terminal failure'))
      assert.equal(dead.status, 'dead')
      assert.ok(dead.deadAt instanceof Date)
      assert.equal(dead.workerId, undefined)
      assert.equal(dead.claimToken, undefined)
      assert.equal(dead.leaseExpiresAt, undefined)

      const replay = await fetch(`${baseUrl}/api/jobs/${job._id}/replay`, {
        method: 'POST',
      })
      assert.equal(replay.status, 200)
      const newClaim = await claimNextJob('new-worker')
      assert.equal(newClaim._id.toString(), job._id.toString())
      assert.notEqual(newClaim.claimToken, staleClaim.claimToken)

      const now = new Date()
      assert.equal(await completeJob(staleClaim, 'stale-worker', now), null)
      assert.equal(
        await failJob(staleClaim, 'stale-worker', new Error('stale update'), { now }),
        null,
      )
      const current = await Job.findById(job._id).lean()
      assert.equal(current.status, 'processing')
      assert.equal(current.workerId, 'new-worker')
      assert.equal(current.payload.value, 'preserved')
      assert.equal(current.attempts, 0)
    })
  },
)
