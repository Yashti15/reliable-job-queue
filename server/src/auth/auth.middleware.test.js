import assert from 'node:assert/strict'
import express from 'express'
import { afterEach, test } from 'node:test'
import cookieParser from 'cookie-parser'
import { createAuthenticate } from './auth.middleware.js'
import { sessionCookieName, signSession } from './session.js'

const originalJwtSecret = process.env.AUTH_JWT_SECRET
let server

afterEach(async () => {
  if (server) {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    server = undefined
  }
  if (originalJwtSecret === undefined) delete process.env.AUTH_JWT_SECRET
  else process.env.AUTH_JWT_SECRET = originalJwtSecret
})

test('protected middleware derives identity from a valid session, not request data', async () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  const expectedUserId = '507f1f77bcf86cd799439011'
  const app = express()
  app.use(express.json())
  app.use(cookieParser())
  app.post(
    '/protected',
    createAuthenticate({
      UserModel: {
        findById(id) {
          assert.equal(id, expectedUserId)
          return {
            select() {
              return Promise.resolve({
                _id: expectedUserId,
                name: 'Owner',
                email: 'owner@example.test',
              })
            },
          }
        },
      },
    }),
    (request, response) => response.json({ userId: String(request.userId) }),
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  const response = await fetch(`http://127.0.0.1:${server.address().port}/protected`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: `${sessionCookieName}=${signSession(expectedUserId)}`,
    },
    body: JSON.stringify({ userId: '507f191e810c19729de860ea' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { userId: expectedUserId })
})

test('protected middleware rejects missing and invalid session cookies', async () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  const app = express()
  app.use(cookieParser())
  app.get(
    '/protected',
    createAuthenticate({
      UserModel: { findById: assert.fail },
    }),
    (_request, response) => response.sendStatus(204),
  )
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  for (const cookie of ['', `${sessionCookieName}=not-a-jwt`]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/protected`, {
      headers: cookie ? { cookie } : {},
    })
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'AUTH_REQUIRED')
  }
})

test('protected middleware reports user-store outages separately from invalid sessions', async () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  const app = express()
  app.use(cookieParser())
  app.get(
    '/protected',
    createAuthenticate({
      UserModel: {
        findById() {
          return {
            select() {
              return Promise.reject(Object.assign(new Error('database unavailable'), {
                name: 'MongooseError',
              }))
            },
          }
        },
      },
    }),
    (_request, response) => response.sendStatus(204),
  )
  const errors = []
  const originalError = console.error
  console.error = (message) => errors.push(message)
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/protected`, {
      headers: { cookie: `${sessionCookieName}=${signSession('507f1f77bcf86cd799439011')}` },
    })
    assert.equal(response.status, 503)
    assert.equal((await response.json()).error.code, 'AUTH_UNAVAILABLE')
    assert.deepEqual(errors, ['Session lookup failed (MongooseError).'])
  } finally {
    console.error = originalError
  }
})
