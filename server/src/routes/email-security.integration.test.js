import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'
import { after, afterEach, before, beforeEach, describe, test } from 'node:test'
import EmailQuota from '../models/email-quota.model.js'
import Job from '../models/job.model.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import { createJobsRouter } from './jobs.routes.js'
import { reserveEmailQuota } from '../worker/email-quota.js'

const testUri = process.env.MONGODB_TEST_URI
const ownerA = new mongoose.Types.ObjectId()
const ownerB = new mongoose.Types.ObjectId()
const now = new Date('2026-11-14T08:30:25.000Z')

describe(
  'shared-provider email safety limits',
  { skip: testUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  () => {
    let closeTestDatabase
    let server
    let baseUrl
    let policy

    before(async () => {
      closeTestDatabase = await connectToIsolatedMongoTestDatabase()
      await Promise.all([Job.init(), EmailQuota.init()])
    })

    beforeEach(async () => {
      await Job.deleteMany({})
      await EmailQuota.deleteMany({})
      policy = {
        enabled: true,
        configured: true,
        allowedRecipients: ['@approved.test'],
        dailyUserQuota: 5,
        dailyGlobalQuota: 20,
        perMinuteUserLimit: 3,
      }

      const app = express()
      app.use(express.json())
      app.use((request, _response, next) => {
        const owner = request.get('x-test-owner') === 'b' ? ownerB : ownerA
        request.authUser = { _id: owner }
        next()
      })
      app.use(
        '/api/jobs',
        createJobsRouter(Job, {
          eventPublisher: async () => true,
          emailPolicyProvider: () => policy,
          now: () => new Date(now),
        }),
      )
      server = app.listen(0, '127.0.0.1')
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
      if (closeTestDatabase) await closeTestDatabase()
    })

    async function create(type = 'send_email', owner = 'a', payload) {
      return fetch(`${baseUrl}/api/jobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-test-owner': owner,
        },
        body: JSON.stringify({
          type,
          payload:
            payload ??
            (type === 'send_email'
              ? {
                  to: 'recipient@approved.test',
                  subject: 'Test message',
                  text: 'Safe test content',
                }
              : {
                  title: 'Report',
                  sections: [
                    { heading: 'Summary', paragraphs: ['Content'] },
                  ],
                }),
        }),
      })
    }

    test('email job creation is disabled by default policy while other job types work', async () => {
      policy = {
        enabled: false,
        configured: false,
        allowedRecipients: [],
      }

      const email = await create()
      assert.equal(email.status, 503)
      assert.equal((await email.json()).error.code, 'EMAIL_SENDING_DISABLED')
      assert.equal((await create('generate_pdf')).status, 201)
    })

    test('server enforces recipient allowlisting and email attempt limits', async () => {
      const blocked = await create('send_email', 'a', {
        to: 'outside@attacker.test',
        subject: 'Denied',
        text: 'Must not be queued',
      })
      assert.equal(blocked.status, 403)
      assert.equal((await blocked.json()).error.code, 'EMAIL_RECIPIENT_NOT_ALLOWED')

      const excessiveAttempts = await fetch(`${baseUrl}/api/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'send_email',
          maxAttempts: 4,
          payload: {
            to: 'recipient@approved.test',
            subject: 'Too many attempts',
            text: 'Test',
          },
        }),
      })
      assert.equal(excessiveAttempts.status, 400)
      assert.equal(
        (await excessiveAttempts.json()).error.code,
        'EMAIL_ATTEMPTS_LIMIT_EXCEEDED',
      )
      assert.equal(await Job.countDocuments({}), 0)
    })

    test('per-user minute rate limit is atomic across requests and isolated by owner', async () => {
      policy.perMinuteUserLimit = 1
      assert.equal((await create()).status, 201)

      const limited = await create()
      assert.equal(limited.status, 429)
      assert.equal((await limited.json()).error.code, 'EMAIL_RATE_LIMITED')

      assert.equal((await create('send_email', 'b')).status, 201)
    })

    test('daily email quota is per-user, global, and includes replays', async () => {
      policy.dailyUserQuota = 1
      policy.perMinuteUserLimit = 10
      assert.equal((await create()).status, 201)

      const secondForSameUser = await create()
      assert.equal(secondForSameUser.status, 429)
      assert.equal(
        (await secondForSameUser.json()).error.code,
        'EMAIL_DAILY_QUOTA_EXCEEDED',
      )
      assert.equal((await create('send_email', 'b')).status, 201)

      policy.dailyUserQuota = 10
      policy.dailyGlobalQuota = 2
      const globalLimited = await create('send_email', 'b')
      assert.equal(globalLimited.status, 429)
      assert.equal(
        (await globalLimited.json()).error.code,
        'EMAIL_GLOBAL_QUOTA_EXCEEDED',
      )

      const dead = await Job.create({
        ownerId: ownerA,
        type: 'send_email',
        payload: {
          to: 'recipient@approved.test',
          subject: 'Replay',
          text: 'Test',
        },
        status: 'dead',
        attempts: 3,
        maxAttempts: 3,
        deadAt: now,
      })
      policy.dailyUserQuota = 1
      const replay = await fetch(`${baseUrl}/api/jobs/${dead._id}/replay`, {
        method: 'POST',
        headers: { 'x-test-owner': 'a' },
      })
      assert.equal(replay.status, 429)
      assert.equal((await replay.json()).error.code, 'EMAIL_DAILY_QUOTA_EXCEEDED')
      assert.equal((await Job.findById(dead._id).lean()).status, 'dead')
    })

    test('actual sends have separate atomic execution quotas from submissions', async () => {
      const executionPolicy = {
        ...policy,
        dailyUserQuota: 1,
        dailyGlobalQuota: 1,
        perMinuteUserLimit: 1,
      }
      const firstExecution = await reserveEmailQuota({
        ownerId: ownerA,
        policy: executionPolicy,
        now,
        usage: 'execution',
      })
      assert.equal(firstExecution.allowed, true)

      const secondOwnerExecution = await reserveEmailQuota({
        ownerId: ownerB,
        policy: executionPolicy,
        now,
        usage: 'execution',
      })
      assert.equal(secondOwnerExecution.allowed, false)
      assert.equal(secondOwnerExecution.code, 'EMAIL_GLOBAL_QUOTA_EXCEEDED')

      const submission = await reserveEmailQuota({
        ownerId: ownerA,
        policy: executionPolicy,
        now,
      })
      assert.equal(submission.allowed, true)
      await submission.release()
    })
  },
)
