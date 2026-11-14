import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import app from '../app.js'
import Job from '../models/job.model.js'
import User from '../models/user.model.js'
import Worker from '../models/worker.model.js'
import EmailQuota from '../models/email-quota.model.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'

const testUri = process.env.MONGODB_TEST_URI
const originalJwtSecret = process.env.AUTH_JWT_SECRET
const originalEmailConfig = {
  enabled: process.env.EMAIL_SENDING_ENABLED,
  recipients: process.env.EMAIL_ALLOWED_RECIPIENTS,
}

test(
  'authenticated API isolates jobs, idempotency keys, analytics, and worker records by tenant',
  { skip: testUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  async (context) => {
    let closeTestDatabase
    let server
    let baseUrl

    context.after(async () => {
      if (server) {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
      if (closeTestDatabase) await closeTestDatabase()
      if (originalJwtSecret === undefined) delete process.env.AUTH_JWT_SECRET
      else process.env.AUTH_JWT_SECRET = originalJwtSecret
      restoreEmailConfig()
    })

    process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
    process.env.EMAIL_SENDING_ENABLED = 'true'
    process.env.EMAIL_ALLOWED_RECIPIENTS = '@example.test'
    closeTestDatabase = await connectToIsolatedMongoTestDatabase()
    await Promise.all([User.init(), Job.init(), Worker.init(), EmailQuota.init()])
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
    baseUrl = `http://127.0.0.1:${server.address().port}`

    async function register(email) {
      const csrfResponse = await fetch(`${baseUrl}/api/auth/csrf`)
      const csrfBody = await csrfResponse.json()
      const csrfCookie = cookieValue(csrfResponse, 'rq_csrf')
      const registration = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: csrfCookie,
          'x-csrf-token': csrfBody.data.csrfToken,
        },
        body: JSON.stringify({
          name: 'Tenant Owner',
          email,
          password: 'secure-password-123',
        }),
      })
      assert.equal(registration.status, 201)
      const sessionCookie = cookieValue(registration, 'rq_session')
      return {
        csrfToken: csrfBody.data.csrfToken,
        cookie: `${csrfCookie}; ${sessionCookie}`,
        sessionCookie,
      }
    }

    async function request(path, owner, options = {}) {
      const headers = {
        cookie: owner.cookie,
        ...(options.method && options.method !== 'GET'
          ? {
              'content-type': 'application/json',
              'x-csrf-token': owner.csrfToken,
            }
          : {}),
        ...options.headers,
      }
      return fetch(`${baseUrl}${path}`, {
        ...options,
        headers,
        ...(options.body ? { body: JSON.stringify(options.body) } : {}),
      })
    }

    const ownerA = await register('tenant-a@example.test')
    const ownerB = await register('tenant-b@example.test')
    const createPayload = {
      type: 'send_email',
      payload: {
        to: 'tenant@example.test',
        subject: 'Tenant check',
        text: 'Test only',
      },
      idempotencyKey: 'same-logical-request',
    }

    const [createdA, createdB] = await Promise.all([
      request('/api/jobs', ownerA, { method: 'POST', body: createPayload }),
      request('/api/jobs', ownerB, { method: 'POST', body: createPayload }),
    ])
    assert.equal(createdA.status, 201)
    assert.equal(createdB.status, 201)
    assert.equal(
      (await request('/api/jobs', ownerA, { method: 'POST', body: createPayload })).status,
      409,
    )
    const jobA = (await createdA.json()).data.job
    const jobB = (await createdB.json()).data.job

    const [listA, listB, crossTenantDetails, crossTenantDelete] = await Promise.all([
      request('/api/jobs', ownerA),
      request('/api/jobs', ownerB),
      request(`/api/jobs/${jobB._id}`, ownerA),
      request(`/api/jobs/${jobB._id}`, ownerA, { method: 'DELETE' }),
    ])
    assert.deepEqual((await listA.json()).data.jobs.map((job) => String(job._id)), [jobA._id])
    assert.deepEqual((await listB.json()).data.jobs.map((job) => String(job._id)), [jobB._id])
    assert.equal(crossTenantDetails.status, 404)
    assert.equal(crossTenantDelete.status, 404)

    const deadJob = await Job.create({
      ownerId: jobB.ownerId,
      type: 'send_email',
      payload: {
        to: 'dead@example.test',
        subject: 'Tenant check',
        text: 'Test only',
      },
      status: 'dead',
      attempts: 3,
      maxAttempts: 3,
      deadAt: new Date(),
      lastError: 'Job processing failed (Error).',
    })
    const [deadListA, deadListB] = await Promise.all([
      request('/api/jobs/dead', ownerA),
      request('/api/jobs/dead', ownerB),
    ])
    assert.deepEqual((await deadListA.json()).data.jobs, [])
    assert.deepEqual(
      (await deadListB.json()).data.jobs.map((job) => String(job._id)),
      [String(deadJob._id)],
    )
    assert.equal(
      (await request(`/api/jobs/${deadJob._id}/replay`, ownerA, { method: 'POST' })).status,
      404,
    )

    await Worker.create({
      workerId: 'tenant-a-worker',
      status: 'active',
      currentJobOwnerId: jobA.ownerId,
      lastSeenAt: new Date(),
      startedAt: new Date(),
    })
    await Worker.create({
      workerId: 'tenant-b-worker',
      status: 'active',
      currentJobOwnerId: jobB.ownerId,
      lastSeenAt: new Date(),
      startedAt: new Date(),
    })
    const [workersA, workersB, analyticsA, analyticsB] = await Promise.all([
      request('/api/workers', ownerA),
      request('/api/workers', ownerB),
      request('/api/analytics', ownerA),
      request('/api/analytics', ownerB),
    ])
    assert.deepEqual(
      (await workersA.json()).data.workers.map((worker) => worker.workerId),
      ['tenant-a-worker'],
    )
    assert.deepEqual(
      (await workersB.json()).data.workers.map((worker) => worker.workerId),
      ['tenant-b-worker'],
    )
    assert.equal((await analyticsA.json()).data.jobs.total, 1)
    assert.equal((await analyticsB.json()).data.jobs.total, 2)

    const stillAuthenticated = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { cookie: ownerA.sessionCookie },
    })
    assert.equal(stillAuthenticated.status, 200)
  },
)

function cookieValue(response, name) {
  const setCookies =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') || '']
  const cookie = setCookies.find((value) => value.startsWith(`${name}=`))
  assert.ok(cookie, `Expected ${name} cookie.`)
  return cookie.split(';')[0]
}

function restoreEmailConfig() {
  if (originalEmailConfig.enabled === undefined) delete process.env.EMAIL_SENDING_ENABLED
  else process.env.EMAIL_SENDING_ENABLED = originalEmailConfig.enabled
  if (originalEmailConfig.recipients === undefined) {
    delete process.env.EMAIL_ALLOWED_RECIPIENTS
  } else {
    process.env.EMAIL_ALLOWED_RECIPIENTS = originalEmailConfig.recipients
  }
}
