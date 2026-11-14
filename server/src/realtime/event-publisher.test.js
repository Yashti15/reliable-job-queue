import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createEventPublisher, sanitizeJobEvent } from './event-publisher.js'

test('job notifications include safe summary fields and omit payload and secrets', () => {
  const notification = sanitizeJobEvent({
    _id: 'job-123',
    type: 'send_email',
    status: 'processing',
    priority: 'high',
    attempts: 1,
    maxAttempts: 3,
    payload: { to: 'private@example.test' },
    lastError: 'private error',
    claimToken: 'private-token',
    idempotencyKey: 'private-key',
    leaseExpiresAt: new Date(),
  })

  assert.deepEqual(notification, {
    jobId: 'job-123',
    type: 'send_email',
    status: 'processing',
    priority: 'high',
    attempts: 1,
    maxAttempts: 3,
  })
})

test('event persistence failures are logged and reported without throwing', async () => {
  const messages = []
  const publish = createEventPublisher({
    EventModel: {
      async create() {
        throw new Error('database connection detail')
      },
    },
    logger: { error: (message) => messages.push(message) },
  })

  assert.equal(await publish('job:created', { jobId: 'job-1' }, 'user-1'), false)
  assert.deepEqual(messages, ['Queue event publication failed (Error).'])
})
