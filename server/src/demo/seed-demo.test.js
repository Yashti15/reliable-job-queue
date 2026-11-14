import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, before, beforeEach, describe, test } from 'node:test'
import mongoose from 'mongoose'
import Job from '../models/job.model.js'
import JobAsset from '../models/job-asset.model.js'
import User from '../models/user.model.js'
import { createFileStore } from '../storage/file-store.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import { seedDemoData } from './seed-demo.js'

const testUri = process.env.MONGODB_TEST_URI

describe(
  'Demo Seed Data integration',
  { skip: testUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  () => {
    let closeDatabase
    let storageRoot
    let store

    before(async () => {
      closeDatabase = await connectToIsolatedMongoTestDatabase()
      storageRoot = await mkdtemp(path.join(os.tmpdir(), 'rq-demo-test-'))
      store = createFileStore({ root: storageRoot })
    })

    beforeEach(async () => {
      await Job.deleteMany({})
      await JobAsset.deleteMany({})
      await User.deleteMany({})
    })

    after(async () => {
      if (storageRoot) {
        await rm(storageRoot, { recursive: true, force: true })
      }
      if (closeDatabase) {
        await closeDatabase()
      }
    })

    test('seedDemoData creates a new demo account and initializes all demo job types', async () => {
      const result = await seedDemoData({
        email: 'test-demo@example.test',
        password: 'TestPassword123!',
        store,
        logger: { info() {} },
      })

      assert.equal(result.user.email, 'test-demo@example.test')
      assert.equal(result.user.isNew, true)
      assert.equal(result.createdJobs.length, 4)

      const jobs = await Job.find({ ownerId: result.user.id }).lean()
      assert.equal(jobs.length, 4)

      const pdfJob = jobs.find((job) => job.type === 'generate_pdf')
      assert.ok(pdfJob)
      assert.equal(pdfJob.status, 'pending')

      const imageJob = jobs.find((job) => job.type === 'process_image')
      assert.ok(imageJob)
      assert.equal(imageJob.status, 'pending')

      const dlqJob = jobs.find((job) => job.status === 'dead')
      assert.ok(dlqJob)
      assert.equal(dlqJob.attempts, 3)
      assert.match(dlqJob.lastError, /DownstreamServiceUnavailableError/)
    })

    test('seedDemoData is idempotent and preserves existing user data on repeat runs', async () => {
      const firstRun = await seedDemoData({
        email: 'test-demo@example.test',
        password: 'TestPassword123!',
        store,
        logger: { info() {} },
      })

      const secondRun = await seedDemoData({
        email: 'test-demo@example.test',
        password: 'NewPasswordIgnored!',
        store,
        logger: { info() {} },
      })

      assert.equal(secondRun.user.id, firstRun.user.id)
      assert.equal(secondRun.user.isNew, false)
      assert.equal(secondRun.createdJobs.length, 0) // No duplicate jobs created
    })
  },
)
