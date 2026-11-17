import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'
import { afterEach, beforeEach, test } from 'node:test'
import { createJobsRouter } from './jobs.routes.js'

class FakeQuery {
  constructor(execute) {
    this.execute = execute
    this.offset = 0
    this.limitValue = Infinity
  }

  sort(sortOptions) {
    this.sortOptions = sortOptions
    return this
  }

  skip(offset) {
    this.offset = offset
    return this
  }

  limit(limitValue) {
    this.limitValue = limitValue
    return this
  }

  lean() {
    return this
  }

  then(resolve, reject) {
    return Promise.resolve()
      .then(this.execute)
      .then((result) => {
        if (!Array.isArray(result)) {
          return result
        }

        const sorted = [...result]
        if (this.sortOptions) {
          const [field, direction] = Object.entries(this.sortOptions)[0]
          sorted.sort((left, right) => {
            const comparison =
              left[field] instanceof Date
                ? left[field] - right[field]
                : String(left[field]).localeCompare(String(right[field]))
            return comparison * direction
          })
        }
        return sorted.slice(this.offset, this.offset + this.limitValue)
      })
      .then(resolve, reject)
  }
}

class FakeJob {
  static documents = new Map()
  static ownerId = new mongoose.Types.ObjectId()

  constructor(data) {
    Object.assign(this, data)
  }

  async save() {
    if (
      this.idempotencyKey &&
      [...FakeJob.documents.values()].some(
        (job) =>
          job.idempotencyKey === this.idempotencyKey &&
          String(job.ownerId) === String(this.ownerId),
      )
    ) {
      const error = new Error('duplicate key')
      error.code = 11000
      error.keyPattern = { idempotencyKey: 1 }
      throw error
    }

    const now = new Date()
    const job = {
      _id: new mongoose.Types.ObjectId().toString(),
      ownerId: this.ownerId,
      type: this.type,
      payload: this.payload,
      status: 'pending',
      priority: this.priority ?? 'normal',
      attempts: 0,
      maxAttempts: this.maxAttempts ?? 3,
      runAt: this.runAt ?? now,
      createdAt: now,
      updatedAt: now,
      ...(this.idempotencyKey ? { idempotencyKey: this.idempotencyKey } : {}),
    }
    FakeJob.documents.set(job._id, job)
    return job
  }

  static matchesFilter(job, filter) {
    for (const [key, value] of Object.entries(filter)) {
      if (key === '$or') {
        const matchesOr = value.some((condition) => FakeJob.matchesFilter(job, condition))
        if (!matchesOr) return false
        continue
      }
      if (key === 'ownerId') {
        if (String(job.ownerId) !== String(value)) return false
        continue
      }
      if (key === '_id') {
        if (String(job._id) !== String(value)) return false
        continue
      }
      if (value && typeof value === 'object' && !(value instanceof Date) && !(value instanceof RegExp)) {
        if (value.$nin && value.$nin.includes(job[key])) return false
        if (value.$regex !== undefined) {
          const r = value.$regex instanceof RegExp ? value.$regex : new RegExp(value.$regex, value.$options)
          if (!r.test(String(job[key] ?? ''))) return false
        }
        if (value.$gte !== undefined && !(job[key] >= value.$gte)) return false
        if (value.$lte !== undefined && !(job[key] <= value.$lte)) return false
        continue
      }
      if (value instanceof RegExp) {
        if (!value.test(String(job[key] ?? ''))) return false
        continue
      }
      if (job[key] !== value) return false
    }
    return true
  }

  static find(filter) {
    return new FakeQuery(() => {
      const jobs = [...FakeJob.documents.values()].filter((job) =>
        FakeJob.matchesFilter(job, filter),
      )
      return jobs
    })
  }

  static countDocuments(filter) {
    return Promise.resolve(
      [...FakeJob.documents.values()].filter((job) =>
        FakeJob.matchesFilter(job, filter),
      ).length,
    )
  }

  static findById(id) {
    return new FakeQuery(() => FakeJob.documents.get(id) ?? null)
  }

  static findOne(filter) {
    return new FakeQuery(() => {
      const job = FakeJob.documents.get(String(filter._id))
      return job && FakeJob.matchesFilter(job, filter) ? job : null
    })
  }

  static findOneAndDelete(filter) {
    return new FakeQuery(() => {
      const job = FakeJob.documents.get(filter._id)
      if (
        !job ||
        job.status !== filter.status ||
        String(job.ownerId) !== String(filter.ownerId)
      ) {
        return null
      }
      FakeJob.documents.delete(filter._id)
      return job
    })
  }

  static findOneAndUpdate(filter, update) {
    return new FakeQuery(() => {
      const job = FakeJob.documents.get(String(filter._id))
      if (!job || !FakeJob.matchesFilter(job, filter)) {
        return null
      }

      Object.assign(job, update.$set ?? {})
      for (const field of Object.keys(update.$unset ?? {})) {
        delete job[field]
      }
      for (const [field, amount] of Object.entries(update.$inc ?? {})) {
        job[field] = (job[field] ?? 0) + amount
      }
      for (const [field, push] of Object.entries(update.$push ?? {})) {
        const values = push.$each ?? [push]
        job[field] = [...(job[field] ?? []), ...values]
        if (push.$slice !== undefined) {
          job[field] = job[field].slice(push.$slice)
        }
      }
      return job
    })
  }

  static seed(data) {
    const now = new Date()
    const job = {
      _id: new mongoose.Types.ObjectId().toString(),
      ownerId: data.ownerId ?? FakeJob.ownerId,
      type: 'test',
      payload: {},
      status: 'pending',
      priority: 'normal',
      attempts: 0,
      maxAttempts: 3,
      runAt: now,
      createdAt: now,
      updatedAt: now,
      ...data,
    }
    FakeJob.documents.set(job._id, job)
    return job
  }
}

let server
let baseUrl

beforeEach(async () => {
  FakeJob.documents = new Map()
  FakeJob.ownerId = new mongoose.Types.ObjectId()
  const app = express()
  app.use(express.json())
  app.use('/api/jobs', (request, _response, next) => {
    request.authUser = { _id: FakeJob.ownerId }
    next()
  })
  app.use('/api/jobs', createJobsRouter(FakeJob))
  server = app.listen(0)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

afterEach(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

async function createJob(body = { type: 'email', payload: { to: 'user@example.test' } }) {
  return fetch(`${baseUrl}/api/jobs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST /api/jobs creates a job with defaults', async () => {
  const response = await createJob()
  const result = await response.json()

  assert.equal(response.status, 201)
  assert.equal(result.success, true)
  assert.equal(result.data.job.type, 'email')
  assert.equal(result.data.job.status, 'pending')
  assert.equal(result.data.job.priority, 'normal')
  assert.equal(result.data.job.attempts, 0)
  assert.equal(result.data.job.maxAttempts, 3)
})

test('POST /api/jobs rejects invalid data and duplicate idempotency keys', async () => {
  const invalid = await createJob({ type: '', payload: [] })
  assert.equal(invalid.status, 400)
  assert.equal((await invalid.json()).error.code, 'INVALID_REQUEST')

  const body = {
    type: 'email',
    payload: { to: 'user@example.test' },
    idempotencyKey: 'request-1',
  }
  assert.equal((await createJob(body)).status, 201)
  const duplicate = await createJob(body)
  assert.equal(duplicate.status, 409)
  assert.equal((await duplicate.json()).error.code, 'IDEMPOTENCY_KEY_CONFLICT')
})

test('GET /api/jobs lists jobs with pagination and status filtering', async () => {
  FakeJob.seed({ status: 'pending', type: 'first' })
  FakeJob.seed({ status: 'completed', type: 'second' })
  FakeJob.seed({ status: 'pending', type: 'third' })

  const response = await fetch(`${baseUrl}/api/jobs?page=2&limit=1&status=pending`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.success, true)
  assert.equal(result.data.jobs.length, 1)
  assert.equal(result.data.jobs[0].status, 'pending')
  assert.deepEqual(result.data.pagination, {
    page: 2,
    limit: 1,
    total: 2,
    totalPages: 2,
  })
})

test('GET /api/jobs/dead lists dead jobs newest first with pagination', async () => {
  const firstDead = FakeJob.seed({
    status: 'dead',
    deadAt: new Date('2025-01-01T00:00:00.000Z'),
  })
  const newestDead = FakeJob.seed({
    status: 'dead',
    deadAt: new Date('2025-01-02T00:00:00.000Z'),
  })
  FakeJob.seed({ status: 'pending' })

  const response = await fetch(`${baseUrl}/api/jobs/dead?page=1&limit=1`)
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.data.jobs.length, 1)
  assert.equal(result.data.jobs[0]._id, newestDead._id)
  assert.deepEqual(result.data.pagination, {
    page: 1,
    limit: 1,
    total: 2,
    totalPages: 2,
  })
  assert.notEqual(result.data.jobs[0]._id, firstDead._id)
})

test('GET /api/jobs/:id fetches an existing job and validates missing jobs and ids', async () => {
  const job = FakeJob.seed({ type: 'report' })

  const found = await fetch(`${baseUrl}/api/jobs/${job._id}`)
  assert.equal(found.status, 200)
  assert.equal((await found.json()).data.job._id, job._id)

  const missing = await fetch(
    `${baseUrl}/api/jobs/${new mongoose.Types.ObjectId().toString()}`,
  )
  assert.equal(missing.status, 404)

  const invalidId = await fetch(`${baseUrl}/api/jobs/not-an-object-id`)
  assert.equal(invalidId.status, 400)
})

test('POST /api/jobs/:id/replay resets a dead job and records audit history', async () => {
  const priorFailure = 'Job processing failed (TypeError).'
  const deadJob = FakeJob.seed({
    type: 'email',
    payload: { to: 'learner@example.test', subject: 'Retry' },
    status: 'dead',
    attempts: 3,
    maxAttempts: 3,
    deadAt: new Date('2025-01-01T00:00:00.000Z'),
    lastError: priorFailure,
    workerId: 'stale-worker',
    claimToken: 'stale-token',
    claimedAt: new Date(),
    leaseExpiresAt: new Date(),
    replayCount: 0,
  })

  const response = await fetch(`${baseUrl}/api/jobs/${deadJob._id}/replay`, {
    method: 'POST',
  })
  const result = await response.json()

  assert.equal(response.status, 200)
  assert.equal(result.data.replayed, true)
  assert.equal(result.data.job.status, 'pending')
  assert.equal(result.data.job.attempts, 0)
  assert.equal(result.data.job.type, 'email')
  assert.deepEqual(result.data.job.payload, deadJob.payload)
  assert.equal(result.data.job.idempotencyKey, deadJob.idempotencyKey)
  assert.equal(result.data.job.deadAt, undefined)
  assert.equal(result.data.job.workerId, undefined)
  assert.equal(result.data.job.claimToken, undefined)
  assert.equal(result.data.job.leaseExpiresAt, undefined)
  assert.equal(result.data.job.replayCount, 1)
  assert.equal(result.data.job.replayHistory[0].previousAttempts, 3)
  assert.equal(result.data.job.replayHistory[0].previousLastError, priorFailure)
})

test('replay accepts only a future runAt and only dead jobs', async () => {
  const deadJob = FakeJob.seed({ status: 'dead', attempts: 2 })
  const futureReplay = await fetch(`${baseUrl}/api/jobs/${deadJob._id}/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runAt: new Date(Date.now() + 60_000).toISOString() }),
  })
  assert.equal(futureReplay.status, 200)
  assert.ok(new Date((await futureReplay.json()).data.job.runAt).getTime() > Date.now())

  const pending = FakeJob.seed({ status: 'pending' })
  const notDead = await fetch(`${baseUrl}/api/jobs/${pending._id}/replay`, {
    method: 'POST',
  })
  assert.equal(notDead.status, 409)
  assert.equal((await notDead.json()).error.code, 'JOB_NOT_REPLAYABLE')

  const invalidDate = await fetch(`${baseUrl}/api/jobs/${deadJob._id}/replay`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runAt: '2020-01-01T00:00:00.000Z' }),
  })
  assert.equal(invalidDate.status, 400)
})

test('concurrent duplicate idempotency-key requests create one job', async () => {
  const body = {
    type: 'email',
    payload: { to: 'learner@example.test' },
    idempotencyKey: 'same-logical-request',
  }
  const responses = await Promise.all([createJob(body), createJob(body)])
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [201, 409],
  )
  assert.equal(FakeJob.documents.size, 1)
})

test('concurrent replay requests can replay a dead job only once', async () => {
  const deadJob = FakeJob.seed({
    status: 'dead',
    attempts: 3,
    deadAt: new Date('2025-01-01T00:00:00.000Z'),
  })
  const responses = await Promise.all([
    fetch(`${baseUrl}/api/jobs/${deadJob._id}/replay`, { method: 'POST' }),
    fetch(`${baseUrl}/api/jobs/${deadJob._id}/replay`, { method: 'POST' }),
  ])
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  )
  assert.equal(FakeJob.documents.get(deadJob._id).replayCount, 1)
})

test('DELETE /api/jobs/:id cancels only pending jobs', async () => {
  const pending = FakeJob.seed({ status: 'pending' })
  const cancelResponse = await fetch(`${baseUrl}/api/jobs/${pending._id}`, {
    method: 'DELETE',
  })

  assert.equal(cancelResponse.status, 200)
  assert.equal((await cancelResponse.json()).data.cancelled, true)
  assert.equal(FakeJob.documents.has(pending._id), false)

  for (const status of ['processing', 'completed']) {
    const job = FakeJob.seed({ status })
    const response = await fetch(`${baseUrl}/api/jobs/${job._id}`, {
      method: 'DELETE',
    })

    assert.equal(response.status, 409)
    assert.equal((await response.json()).error.code, 'JOB_NOT_CANCELLABLE')
    assert.equal(FakeJob.documents.has(job._id), true)
  }
})

test('GET /api/jobs supports search by text, type, priority, and date range', async () => {
  FakeJob.documents.clear()
  const d1 = new Date('2025-01-01T10:00:00Z')
  const d2 = new Date('2025-01-05T10:00:00Z')
  const d3 = new Date('2025-01-10T10:00:00Z')

  const j1 = FakeJob.seed({ type: 'generate_pdf', priority: 'high', createdAt: d1, idempotencyKey: 'invoice-101' })
  const j2 = FakeJob.seed({ type: 'process_image', priority: 'normal', createdAt: d2, idempotencyKey: 'avatar-user-5' })
  const j3 = FakeJob.seed({ type: 'send_email', priority: 'low', createdAt: d3 })

  // 1. Search by type
  const searchTypeRes = await fetch(`${baseUrl}/api/jobs?q=pdf`)
  assert.equal(searchTypeRes.status, 200)
  const searchTypeData = await searchTypeRes.json()
  assert.equal(searchTypeData.data.jobs.length, 1)
  assert.equal(searchTypeData.data.jobs[0]._id, j1._id)

  // 2. Search by idempotencyKey
  const searchKeyRes = await fetch(`${baseUrl}/api/jobs?q=avatar`)
  assert.equal(searchKeyRes.status, 200)
  const searchKeyData = await searchKeyRes.json()
  assert.equal(searchKeyData.data.jobs.length, 1)
  assert.equal(searchKeyData.data.jobs[0]._id, j2._id)

  // 3. Search by exact ObjectId
  const searchIdRes = await fetch(`${baseUrl}/api/jobs?q=${j3._id}`)
  assert.equal(searchIdRes.status, 200)
  const searchIdData = await searchIdRes.json()
  assert.equal(searchIdData.data.jobs.length, 1)
  assert.equal(searchIdData.data.jobs[0]._id, j3._id)

  // 4. Filter by priority
  const prioRes = await fetch(`${baseUrl}/api/jobs?priority=high`)
  assert.equal(prioRes.status, 200)
  const prioData = await prioRes.json()
  assert.equal(prioData.data.jobs.length, 1)
  assert.equal(prioData.data.jobs[0].priority, 'high')

  // 5. Filter by type
  const typeRes = await fetch(`${baseUrl}/api/jobs?type=send_email`)
  assert.equal(typeRes.status, 200)
  const typeData = await typeRes.json()
  assert.equal(typeData.data.jobs.length, 1)
  assert.equal(typeData.data.jobs[0].type, 'send_email')

  // 6. Filter by date range
  const dateRes = await fetch(`${baseUrl}/api/jobs?startDate=2025-01-04T00:00:00Z&endDate=2025-01-06T00:00:00Z`)
  assert.equal(dateRes.status, 200)
  const dateData = await dateRes.json()
  assert.equal(dateData.data.jobs.length, 1)
  assert.equal(dateData.data.jobs[0]._id, j2._id)
})

test('POST /api/jobs/:id/retry retries non-active jobs, resets attempts, and prevents retrying pending/processing jobs', async () => {
  FakeJob.documents.clear()
  const failedJob = FakeJob.seed({
    status: 'failed',
    attempts: 2,
    lastError: 'Temporary network failure',
  })

  // Retry failed job
  const retryRes = await fetch(`${baseUrl}/api/jobs/${failedJob._id}/retry`, { method: 'POST' })
  assert.equal(retryRes.status, 200)
  const retryBody = await retryRes.json()
  assert.equal(retryBody.success, true)
  assert.equal(retryBody.data.retried, true)
  assert.equal(retryBody.data.job.status, 'pending')
  assert.equal(retryBody.data.job.attempts, 0)
  assert.equal(retryBody.data.job.replayCount, 1)
  assert.equal(retryBody.data.job.replayHistory.length, 1)

  // Retrying pending job should fail (409)
  const pendingRetryRes = await fetch(`${baseUrl}/api/jobs/${failedJob._id}/retry`, { method: 'POST' })
  assert.equal(pendingRetryRes.status, 409)
  const pendingError = await pendingRetryRes.json()
  assert.equal(pendingError.error.code, 'JOB_NOT_RETRYABLE')
})
