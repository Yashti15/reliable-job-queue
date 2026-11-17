import assert from 'node:assert/strict'
import { test } from 'node:test'
import Job from './job.model.js'

test('job schema requires type and object payload', () => {
  const error = new Job({}).validateSync()

  assert.ok(error.errors.type)
  assert.ok(error.errors.payload)
  assert.match(error.errors.payload.message, /Path `payload` is required/)
})

test('job schema applies defaults and rejects invalid enum and numeric values', () => {
  const job = new Job({ type: 'email', payload: { to: 'user@example.test' } })

  assert.equal(job.status, 'pending')
  assert.equal(job.priority, 'normal')
  assert.equal(job.attempts, 0)
  assert.equal(job.maxAttempts, 3)
  assert.ok(job.runAt instanceof Date)
  assert.ok(job.validateSync() === undefined)

  const invalidJob = new Job({
    type: 'email',
    payload: {},
    status: 'cancelled',
    priority: 'urgent',
    attempts: -1,
    maxAttempts: 0,
  })
  const error = invalidJob.validateSync()

  assert.ok(error.errors.status)
  assert.ok(error.errors.priority)
  assert.ok(error.errors.attempts)
  assert.ok(error.errors.maxAttempts)
})

test('job schema enables timestamps and a tenant-scoped unique idempotency index', () => {
  assert.equal(Job.schema.options.timestamps, true)

  const indexes = Job.schema.indexes()
  const idempotencyIndex = indexes.find(
    ([fields]) => fields.ownerId === 1 && fields.idempotencyKey === 1,
  )

  assert.ok(idempotencyIndex)
  assert.equal(idempotencyIndex[1].unique, true)
  assert.deepEqual(idempotencyIndex[1].partialFilterExpression, {
    ownerId: { $type: 'objectId' },
    idempotencyKey: { $type: 'string' },
  })
  assert.equal(Job.schema.path('ownerId').instance, 'ObjectId')
  assert.equal(Job.schema.path('workerId').instance, 'String')
  assert.equal(Job.schema.path('claimedAt').instance, 'Date')
  assert.equal(Job.schema.path('completedAt').instance, 'Date')
  assert.equal(Job.schema.path('deadAt').instance, 'Date')
  assert.equal(Job.schema.path('replayCount').defaultValue, 0)
  assert.ok(Array.isArray(new Job({ type: 'test', payload: {} }).replayHistory))
  assert.ok(Array.isArray(new Job({ type: 'test', payload: {} }).attemptHistory))
  assert.ok(
    indexes.some(
      ([fields]) =>
        fields.status === 1 && fields.deadAt === -1 && fields._id === -1,
    ),
  )
})

test('job schema supports progress tracking and attempt history', () => {
  const validJob = new Job({
    type: 'process_image',
    payload: { assetId: '507f1f77bcf86cd799439011' },
    progress: {
      percent: 45,
      stage: 'resizing',
      message: 'Processing image dimensions',
      updatedAt: new Date(),
    },
    attemptHistory: [
      {
        attempt: 1,
        workerId: 'worker-node-1',
        startedAt: new Date(Date.now() - 5000),
        finishedAt: new Date(),
        durationMs: 5000,
        error: 'Transient storage error',
      },
    ],
  })
  assert.equal(validJob.validateSync(), undefined)
  assert.equal(validJob.progress.percent, 45)
  assert.equal(validJob.progress.stage, 'resizing')
  assert.equal(validJob.attemptHistory.length, 1)
  assert.equal(validJob.attemptHistory[0].attempt, 1)

  const invalidProgress = new Job({
    type: 'process_image',
    payload: { assetId: '507f1f77bcf86cd799439011' },
    progress: {
      percent: 150, // exceeds max 100
    },
  })
  const progressError = invalidProgress.validateSync()
  assert.ok(progressError?.errors?.['progress.percent'])
})
