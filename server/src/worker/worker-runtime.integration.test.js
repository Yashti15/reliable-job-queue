import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { after, before, beforeEach, describe, test } from 'node:test'
import Job from '../models/job.model.js'
import {
  claimNextJob,
  completeJob,
  failJob,
} from '../queue/job-queue.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import { createWorker } from './worker-runtime.js'

const testUri = process.env.MONGODB_TEST_URI
const testOwnerId = new mongoose.Types.ObjectId()
const silentLogger = { info() {}, warn() {}, error() {} }

describe(
  'MongoDB worker execution integration',
  { skip: testUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  () => {
    let closeTestDatabase

    before(async () => {
      closeTestDatabase = await connectToIsolatedMongoTestDatabase()
      await Job.init()
      const create = Job.create.bind(Job)
      Job.create = (data, options) =>
        create({ ownerId: testOwnerId, ...data }, options)
    })

    beforeEach(async () => {
      await Job.deleteMany({})
    })

    after(async () => {
      Job.create = mongoose.Model.create.bind(Job)
      if (closeTestDatabase) {
        await closeTestDatabase()
      }
    })

    test('successful handler execution completes its owned job', async () => {
      const job = await Job.create({
        type: 'send_email',
        payload: { to: 'learner@example.test', subject: 'Welcome' },
      })
      const worker = createWorker({
        workerId: 'success-worker',
        queue: { claimNextJob, completeJob, failJob },
        getHandler: () => async () => ({
          type: 'email',
          provider: 'resend',
          status: 'accepted',
          providerMessageId: 'mock-provider-id',
        }),
        logger: silentLogger,
      })

      assert.equal(await worker.processNextJob(), true)
      const completed = await Job.findById(job._id).lean()
      assert.equal(completed.status, 'completed')
      assert.equal(completed.workerId, 'success-worker')
      assert.ok(completed.claimedAt instanceof Date)
      assert.ok(completed.completedAt instanceof Date)
      assert.equal(completed.attempts, 0)
    })

    test('failed handlers record a safe failure and worker continues', async () => {
      const firstJob = await Job.create({ type: 'will_fail', payload: {} })
      const secondJob = await Job.create({ type: 'will_succeed', payload: {} })
      const worker = createWorker({
        workerId: 'failure-worker',
        queue: { claimNextJob, completeJob, failJob },
        getHandler: (type) =>
          type === 'will_fail'
            ? async () => {
                throw new Error('sensitive handler detail')
              }
            : async () => ({ ok: true }),
        logger: silentLogger,
      })

      assert.equal(await worker.processNextJob(), true)
      assert.equal(await worker.processNextJob(), true)
      const failed = await Job.findById(firstJob._id).lean()
      const completed = await Job.findById(secondJob._id).lean()
      assert.equal(failed.status, 'pending')
      assert.equal(failed.attempts, 1)
      assert.equal(failed.workerId, undefined)
      assert.equal(failed.claimedAt, undefined)
      assert.doesNotMatch(failed.lastError, /sensitive handler detail/)
      assert.equal(completed.status, 'completed')
    })

    test('unknown job types fail safely without crashing the worker', async () => {
      const job = await Job.create({ type: 'unregistered', payload: {} })
      const worker = createWorker({
        workerId: 'unknown-type-worker',
        queue: { claimNextJob, completeJob, failJob },
        getHandler: () => undefined,
        logger: silentLogger,
      })

      assert.equal(await worker.processNextJob(), true)
      const failed = await Job.findById(job._id).lean()
      assert.equal(failed.status, 'pending')
      assert.equal(failed.attempts, 1)
      assert.match(failed.lastError, /UnknownJobTypeError/)
      assert.equal(failed.workerId, undefined)
      assert.equal(await worker.processNextJob(), false)
    })

    test('final worker failure moves the job to dead and clears its lease', async () => {
      const job = await Job.create({
        type: 'terminal_failure',
        payload: {},
        maxAttempts: 1,
      })
      const worker = createWorker({
        workerId: 'terminal-failure-worker',
        queue: { claimNextJob, completeJob, failJob },
        getHandler: () => async () => {
          throw new Error('terminal failure')
        },
        logger: silentLogger,
      })

      assert.equal(await worker.processNextJob(), true)
      const dead = await Job.findById(job._id).lean()
      assert.equal(dead.status, 'dead')
      assert.equal(dead.attempts, 1)
      assert.ok(dead.deadAt instanceof Date)
      assert.equal(dead.workerId, undefined)
      assert.equal(dead.claimToken, undefined)
      assert.equal(dead.leaseExpiresAt, undefined)
      assert.equal(await claimNextJob('another-worker'), null)
    })

    test('completion and failure updates require current worker ownership', async () => {
      const job = await Job.create({ type: 'test', payload: {} })
      const claimed = await claimNextJob('current-worker')

      assert.equal(claimed._id.toString(), job._id.toString())
      assert.equal(await completeJob(claimed, 'stale-worker'), null)
      assert.equal(await failJob(claimed, 'stale-worker', new Error('stale')), null)

      const stillOwned = await Job.findById(job._id).lean()
      assert.equal(stillOwned.status, 'processing')
      assert.equal(stillOwned.workerId, 'current-worker')

      const completed = await completeJob(claimed, 'current-worker')
      assert.equal(completed.status, 'completed')
    })

    test('a retried job can succeed on its next execution without another increment', async () => {
      const job = await Job.create({
        type: 'eventual_success',
        payload: {},
        maxAttempts: 3,
      })
      const firstClaim = await claimNextJob('first-attempt-worker')
      const retryAt = new Date(Date.now() - 1000)
      const retried = await failJob(
        firstClaim,
        'first-attempt-worker',
        new Error('first attempt failed'),
        {
          now: retryAt,
          retryOptions: {
            baseDelayMs: 1,
            maxRetryDelayMs: 100,
            jitterRatio: 0,
          },
          random: () => 0,
        },
      )
      assert.equal(retried.status, 'pending')
      assert.equal(retried.attempts, 1)

      const secondClaim = await claimNextJob('second-attempt-worker')
      const worker = createWorker({
        workerId: 'second-attempt-worker',
        queue: {
          claimNextJob: async () => secondClaim,
          completeJob,
          failJob,
        },
        getHandler: () => async () => ({ succeeded: true }),
        logger: silentLogger,
      })

      assert.equal(await worker.processNextJob(), true)
      const completed = await Job.findById(job._id).lean()
      assert.equal(completed.status, 'completed')
      assert.equal(completed.attempts, 1)
      assert.equal(completed.workerId, 'second-attempt-worker')
      assert.ok(completed.completedAt instanceof Date)
    })
  },
)
