import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { after, before, beforeEach, describe, test } from 'node:test'
import Job from '../models/job.model.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import {
  claimNextJob,
  completeJob,
  failJob,
  renewLease,
} from './job-queue.js'

const testUri = process.env.MONGODB_TEST_URI
const testOwnerId = new mongoose.Types.ObjectId()

describe(
  'MongoDB job claiming integration',
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

    test('two concurrent workers cannot claim the same job', async () => {
      const job = await Job.create({
        type: 'test',
        payload: {},
        status: 'pending',
        priority: 'normal',
        runAt: new Date(Date.now() - 1000),
      })

      const claims = await Promise.all([
        claimNextJob('worker-a'),
        claimNextJob('worker-b'),
      ])
      const successfulClaims = claims.filter(Boolean)

      assert.equal(successfulClaims.length, 1)
      assert.equal(successfulClaims[0]._id.toString(), job._id.toString())
      assert.ok(['worker-a', 'worker-b'].includes(successfulClaims[0].workerId))
      assert.equal(successfulClaims[0].status, 'processing')
      assert.ok(successfulClaims[0].claimedAt instanceof Date)
      assert.ok(successfulClaims[0].leaseExpiresAt instanceof Date)
      assert.equal(typeof successfulClaims[0].claimToken, 'string')
      assert.ok(successfulClaims[0].claimToken.length > 0)
    })

    test('heartbeat extends an unexpired lease and rejects expired or stale claims', async () => {
      const baseTime = new Date()
      const created = await Job.create({ type: 'test', payload: {}, runAt: baseTime })
      const claimed = await claimNextJob('lease-owner', {
        now: baseTime,
        leaseDurationMs: 5000,
      })
      assert.equal(claimed._id.toString(), created._id.toString())
      assert.equal(claimed.leaseExpiresAt.getTime(), baseTime.getTime() + 5000)

      const renewedAt = new Date(baseTime.getTime() + 1000)
      const renewed = await renewLease(claimed, 'lease-owner', {
        now: renewedAt,
        leaseDurationMs: 5000,
      })
      assert.equal(renewed.leaseExpiresAt.getTime(), renewedAt.getTime() + 5000)
      assert.equal(renewed.workerId, 'lease-owner')
      assert.equal(renewed.claimToken, claimed.claimToken)
      assert.equal(await renewLease(claimed, 'other-owner', { now: renewedAt }), null)
      assert.equal(
        await renewLease(claimed, 'lease-owner', {
          now: new Date(renewed.leaseExpiresAt.getTime()),
        }),
        null,
      )
    })

    test('claims high priority first and older jobs first within a priority', async () => {
      const now = new Date()
      const olderNormal = await Job.create({
        type: 'test',
        payload: { label: 'older-normal' },
        priority: 'normal',
        runAt: new Date(now.getTime() - 1000),
        createdAt: new Date(now.getTime() - 2000),
      })
      const newerNormal = await Job.create({
        type: 'test',
        payload: { label: 'newer-normal' },
        priority: 'normal',
        runAt: new Date(now.getTime() - 1000),
        createdAt: new Date(now.getTime() - 1000),
      })
      const high = await Job.create({
        type: 'test',
        payload: { label: 'high' },
        priority: 'high',
        runAt: new Date(now.getTime() - 1000),
      })
      await Job.create({
        type: 'test',
        payload: { label: 'low' },
        priority: 'low',
        runAt: new Date(now.getTime() - 1000),
      })

      assert.equal((await claimNextJob('priority-worker'))._id.toString(), high._id.toString())
      assert.equal(
        (await claimNextJob('priority-worker'))._id.toString(),
        olderNormal._id.toString(),
      )
      assert.equal(
        (await claimNextJob('priority-worker'))._id.toString(),
        newerNormal._id.toString(),
      )
    })

    test('does not claim jobs scheduled in the future', async () => {
      const futureJob = await Job.create({
        type: 'test',
        payload: {},
        priority: 'high',
        runAt: new Date(Date.now() + 60_000),
      })

      assert.equal(await claimNextJob('early-worker'), null)
      assert.equal((await Job.findById(futureJob._id).lean()).status, 'pending')
    })

    test('failed execution retries once, clears ownership, waits for runAt, then can be claimed', async () => {
      const job = await Job.create({
        type: 'test',
        payload: {},
        maxAttempts: 3,
      })
      const claimed = await claimNextJob('retry-worker')
      const failedAt = new Date(Date.now() + 1000)
      const retryOptions = {
        baseDelayMs: 2000,
        maxRetryDelayMs: 60_000,
        jitterRatio: 0.2,
      }

      const retried = await failJob(
        claimed,
        'retry-worker',
        new TypeError('Expected test failure'),
        { now: failedAt, retryOptions, random: () => 0.5 },
      )
      assert.equal(retried.status, 'pending')
      assert.equal(retried.attempts, 1)
      assert.equal(retried.lastError, 'Job processing failed (TypeError).')
      assert.equal(retried.workerId, undefined)
      assert.equal(retried.claimedAt, undefined)
      assert.equal(retried.claimToken, undefined)
      assert.equal(retried.leaseExpiresAt, undefined)
      assert.equal(retried.runAt.getTime(), failedAt.getTime() + 2200)

      assert.equal(
        await failJob(claimed, 'retry-worker', new Error('duplicate failure'), {
          now: failedAt,
          retryOptions,
          random: () => 0,
        }),
        null,
      )
      assert.equal((await Job.findById(job._id).lean()).attempts, 1)
      assert.equal(
        await claimNextJob('early-worker', new Date(retried.runAt.getTime() - 1)),
        null,
      )

      const dueJob = await claimNextJob(
        'second-attempt-worker',
        new Date(retried.runAt.getTime() + 1),
      )
      assert.equal(dueJob._id.toString(), job._id.toString())
      assert.equal(dueJob.attempts, 1)
    })

    test('final allowed failure enters dead-letter state and clears worker ownership', async () => {
      const job = await Job.create({
        type: 'test',
        payload: {},
        maxAttempts: 1,
      })
      const claimed = await claimNextJob('final-attempt-worker')

      const failed = await failJob(
        claimed,
        'final-attempt-worker',
        new Error('final failure'),
        { random: () => 0 },
      )

      assert.equal(failed.status, 'dead')
      assert.equal(failed.attempts, 1)
      assert.ok(failed.deadAt instanceof Date)
      assert.equal(failed.workerId, undefined)
      assert.equal(failed.claimedAt, undefined)
      assert.equal(failed.claimToken, undefined)
      assert.equal(failed.leaseExpiresAt, undefined)
      assert.equal(await claimNextJob('normal-worker'), null)
    })

    test('stale worker cannot retry or increment attempts for another owner', async () => {
      const job = await Job.create({
        type: 'test',
        payload: {},
        maxAttempts: 3,
      })
      const claimed = await claimNextJob('current-owner')
      const staleUpdate = await failJob(
        claimed,
        'stale-owner',
        new Error('stale failure'),
        { random: () => 0 },
      )

      assert.equal(staleUpdate, null)
      const unchanged = await Job.findById(job._id).lean()
      assert.equal(unchanged.status, 'processing')
      assert.equal(unchanged.workerId, 'current-owner')
      assert.equal(unchanged.attempts, 0)
    })

    test('expired lease is reclaimed once with a fresh token and one abandoned attempt', async () => {
      const start = new Date('2025-01-01T00:00:00.000Z')
      const job = await Job.create({
        type: 'test',
        payload: {},
        status: 'processing',
        workerId: 'crashed-worker',
        claimToken: 'old-token',
        claimedAt: start,
        leaseExpiresAt: new Date(start.getTime() + 1000),
        maxAttempts: 3,
        createdAt: start,
      })
      const now = new Date(start.getTime() + 1001)

      const [first, second] = await Promise.all([
        claimNextJob('recovery-a', { now, leaseDurationMs: 5000 }),
        claimNextJob('recovery-b', { now, leaseDurationMs: 5000 }),
      ])
      const reclaimed = [first, second].filter(Boolean)

      assert.equal(reclaimed.length, 1)
      assert.equal(reclaimed[0]._id.toString(), job._id.toString())
      assert.notEqual(reclaimed[0].claimToken, 'old-token')
      assert.equal(reclaimed[0].attempts, 1)
      assert.equal(reclaimed[0].workerId, first ? 'recovery-a' : 'recovery-b')
      assert.equal(reclaimed[0].leaseExpiresAt.getTime(), now.getTime() + 5000)
    })

    test('expired lease is not recovered before expiry', async () => {
      const start = new Date('2025-01-01T00:00:00.000Z')
      const job = await Job.create({
        type: 'test',
        payload: {},
        status: 'processing',
        workerId: 'healthy-worker',
        claimToken: 'active-token',
        claimedAt: start,
        leaseExpiresAt: new Date(start.getTime() + 1000),
      })

      assert.equal(
        await claimNextJob('early-recovery', {
          now: new Date(start.getTime() + 999),
        }),
        null,
      )
      const unchanged = await Job.findById(job._id).lean()
      assert.equal(unchanged.workerId, 'healthy-worker')
      assert.equal(unchanged.attempts, 0)
    })

    test('expired execution at maxAttempts is dead-lettered and counted once', async () => {
      const start = new Date('2025-01-01T00:00:00.000Z')
      const job = await Job.create({
        type: 'test',
        payload: {},
        status: 'processing',
        workerId: 'crashed-worker',
        claimToken: 'expired-token',
        claimedAt: start,
        leaseExpiresAt: new Date(start.getTime() + 1000),
        maxAttempts: 1,
      })

      assert.equal(
        await claimNextJob('last-worker', {
          now: new Date(start.getTime() + 1001),
        }),
        null,
      )
      const failed = await Job.findById(job._id).lean()
      assert.equal(failed.status, 'dead')
      assert.equal(failed.attempts, 1)
      assert.ok(failed.deadAt instanceof Date)
      assert.match(failed.lastError, /lease expired/)
      assert.equal(failed.workerId, undefined)
      assert.equal(failed.claimToken, undefined)
      assert.equal(failed.leaseExpiresAt, undefined)
    })

    test('previous owner cannot complete or fail after lease recovery', async () => {
      const start = new Date('2025-01-01T00:00:00.000Z')
      const job = await Job.create({
        type: 'test',
        payload: {},
        status: 'processing',
        workerId: 'same-worker',
        claimToken: 'old-token',
        claimedAt: start,
        leaseExpiresAt: new Date(start.getTime() + 1000),
        maxAttempts: 3,
      })

      const oldClaim = await Job.findById(job._id).lean()
      const reclaimed = await claimNextJob('same-worker', {
        now: new Date(start.getTime() + 1001),
      })

      assert.equal(await completeJob(oldClaim, 'same-worker', new Date(start.getTime() + 1002)), null)
      assert.equal(
        await failJob(oldClaim, 'same-worker', new Error('stale'), {
          now: new Date(start.getTime() + 1002),
        }),
        null,
      )
      assert.equal(
        await renewLease(oldClaim, 'same-worker', {
          now: new Date(start.getTime() + 1002),
        }),
        null,
      )
      const stillOwned = await Job.findById(job._id).lean()
      assert.equal(stillOwned.workerId, 'same-worker')
      assert.equal(stillOwned.claimToken, reclaimed.claimToken)
      assert.equal(stillOwned.attempts, 1)
    })

    test('only accepted claims and completion updates publish lifecycle events', async () => {
      const eventNames = []
      const publish = async (name) => {
        eventNames.push(name)
        return true
      }
      const now = new Date()
      const created = await Job.create({
        type: 'test',
        payload: {},
        status: 'pending',
        runAt: now,
      })

      const claimed = await claimNextJob('event-worker', {
        now,
        eventPublisher: publish,
      })
      assert.equal(claimed._id.toString(), created._id.toString())

      const staleClaim = { ...claimed, claimToken: 'stale-token' }
      assert.equal(
        await completeJob(staleClaim, 'event-worker', new Date(now.getTime() + 1), publish),
        null,
      )
      assert.deepEqual(eventNames, ['job:claimed'])

      const completed = await completeJob(
        claimed,
        'event-worker',
        new Date(now.getTime() + 1),
        publish,
      )
      assert.equal(completed.status, 'completed')
      assert.deepEqual(eventNames, ['job:claimed', 'job:completed'])
    })

    test('completion persists only bounded handler result metadata under the active claim', async () => {
      const now = new Date()
      const created = await Job.create({
        type: 'generate_pdf',
        payload: {},
        status: 'pending',
        runAt: now,
      })
      const claimed = await claimNextJob('result-worker', { now })
      const result = {
        type: 'pdf',
        title: 'Queue report',
        artifacts: [
          {
            assetId: new mongoose.Types.ObjectId().toString(),
            fileName: 'report.pdf',
            mediaType: 'application/pdf',
            sizeBytes: 1200,
            storageKey: 'must-not-be-persisted.pdf',
          },
        ],
      }

      const completed = await completeJob(
        claimed,
        'result-worker',
        new Date(now.getTime() + 1),
        async () => true,
        result,
      )
      assert.equal(completed.status, 'completed')
      assert.deepEqual(completed.result, {
        type: 'pdf',
        title: 'Queue report',
        artifacts: [
          {
            assetId: result.artifacts[0].assetId,
            fileName: 'report.pdf',
            mediaType: 'application/pdf',
            sizeBytes: 1200,
          },
        ],
      })
      const stored = await Job.findById(created._id).lean()
      assert.equal(stored.result.internalPath, undefined)
      assert.equal(stored.result.artifacts[0].storageKey, undefined)
    })

    test('workers do not claim legacy ownerless jobs', async () => {
      await new Job({
        type: 'legacy',
        payload: {},
        status: 'pending',
        priority: 'high',
        runAt: new Date(Date.now() - 1000),
      }).save()
      const owned = await Job.create({
        type: 'owned',
        payload: {},
        status: 'pending',
        priority: 'normal',
        runAt: new Date(Date.now() - 1000),
      })

      const claimed = await claimNextJob('tenant-worker')
      assert.equal(String(claimed._id), String(owned._id))
      assert.ok(claimed.ownerId)
      assert.equal(await claimNextJob('second-worker'), null)
    })

    test('retry and dead-letter transitions publish only the persisted states', async () => {
      const eventNames = []
      const publish = async (name) => {
        eventNames.push(name)
        return true
      }
      const start = new Date()
      await Job.create({
        type: 'test',
        payload: {},
        maxAttempts: 2,
        runAt: start,
      })

      const firstClaim = await claimNextJob('retry-event-worker', {
        now: start,
        eventPublisher: publish,
      })
      const retry = await failJob(firstClaim, 'retry-event-worker', new Error('retry'), {
        now: start,
        retryOptions: { baseDelayMs: 1, maxRetryDelayMs: 1, jitterRatio: 0 },
        eventPublisher: publish,
      })
      assert.equal(retry.status, 'pending')
      assert.deepEqual(eventNames, ['job:claimed', 'job:failed', 'job:retried'])

      const secondClaim = await claimNextJob('retry-event-worker', {
        now: new Date(retry.runAt.getTime() + 1),
        eventPublisher: publish,
      })
      const dead = await failJob(secondClaim, 'retry-event-worker', new Error('final'), {
        now: new Date(retry.runAt.getTime() + 2),
        eventPublisher: publish,
      })
      assert.equal(dead.status, 'dead')
      assert.deepEqual(eventNames, [
        'job:claimed',
        'job:failed',
        'job:retried',
        'job:claimed',
        'job:failed',
        'job:dead',
      ])
    })
  },
)
