import assert from 'node:assert/strict'
import express from 'express'
import cookieParser from 'cookie-parser'
import jwt from 'jsonwebtoken'
import { after, before, beforeEach, describe, test } from 'node:test'
import User from '../models/user.model.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import { createAuthRouter } from './auth.routes.js'

const testUri = process.env.MONGODB_TEST_URI
const originalJwtSecret = process.env.AUTH_JWT_SECRET
process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'

describe(
  'MongoDB authentication integration',
  { skip: testUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  () => {
    let closeTestDatabase
    let server
    let baseUrl

    before(async () => {
      closeTestDatabase = await connectToIsolatedMongoTestDatabase()
      await User.init()
      const app = express()
      app.use(express.json())
      app.use(cookieParser())
      app.use('/api/auth', createAuthRouter())
      server = app.listen(0, '127.0.0.1')
      await new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      baseUrl = `http://127.0.0.1:${server.address().port}`
    })

    beforeEach(async () => {
      await User.deleteMany({})
    })

    after(async () => {
      if (server) {
        await new Promise((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
      }
      if (closeTestDatabase) await closeTestDatabase()
      if (originalJwtSecret === undefined) delete process.env.AUTH_JWT_SECRET
      else process.env.AUTH_JWT_SECRET = originalJwtSecret
    })

    async function csrf() {
      const response = await fetch(`${baseUrl}/api/auth/csrf`)
      const body = await response.json()
      return {
        token: body.data.csrfToken,
        cookie: setCookieValues(response).find((value) => value.startsWith('rq_csrf=')),
      }
    }

    async function register(email = 'operator@example.test') {
      const csrfData = await csrf()
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: csrfData.cookie,
          'x-csrf-token': csrfData.token,
        },
        body: JSON.stringify({
          name: 'Queue Operator',
          email,
          password: 'secure-password-123',
        }),
      })
      return { response, csrfData }
    }

    test('registration hashes passwords, normalizes email, and omits password hash', async () => {
      const { response } = await register('  Operator@Example.Test ')
      const result = await response.json()
      const stored = await User.findOne({ email: 'operator@example.test' }).select('+passwordHash')

      assert.equal(response.status, 201)
      assert.equal(result.data.user.email, 'operator@example.test')
      assert.equal('passwordHash' in result.data.user, false)
      assert.notEqual(stored.passwordHash, 'secure-password-123')
      assert.equal(await (await import('bcryptjs')).default.compare('secure-password-123', stored.passwordHash), true)
      assert.ok(setCookieValues(response).some((value) => value.startsWith('rq_session=')))
    })

    test('duplicate registration and invalid email or weak passwords are rejected', async () => {
      assert.equal((await register()).response.status, 201)
      assert.equal((await register('OPERATOR@example.test')).response.status, 409)

      const badInputs = [
        { name: 'Name', email: 'not-an-email', password: 'secure-password-123' },
        { name: 'Name', email: 'valid@example.test', password: 'short' },
      ]
      for (const body of badInputs) {
        const csrfData = await csrf()
        const response = await fetch(`${baseUrl}/api/auth/register`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: csrfData.cookie,
            'x-csrf-token': csrfData.token,
          },
          body: JSON.stringify(body),
        })
        assert.equal(response.status, 400)
      }
    })

    test('login uses one generic error for unknown email and wrong password', async () => {
      await register()
      for (const credentials of [
        { email: 'missing@example.test', password: 'secure-password-123' },
        { email: 'operator@example.test', password: 'incorrect-password' },
      ]) {
        const csrfData = await csrf()
        const response = await fetch(`${baseUrl}/api/auth/login`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: csrfData.cookie,
            'x-csrf-token': csrfData.token,
          },
          body: JSON.stringify(credentials),
        })
        const result = await response.json()
        assert.equal(response.status, 401)
        assert.deepEqual(result.error, {
          code: 'INVALID_CREDENTIALS',
          message: 'Email or password is incorrect.',
        })
      }

      const csrfData = await csrf()
      const validLogin = await fetch(`${baseUrl}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: csrfData.cookie,
          'x-csrf-token': csrfData.token,
        },
        body: JSON.stringify({ email: 'OPERATOR@example.test', password: 'secure-password-123' }),
      })
      assert.equal(validLogin.status, 200)
      assert.ok(setCookieValues(validLogin).some((value) => value.startsWith('rq_session=')))
    })

    test('current user rejects missing, malformed, and expired JWT cookies', async () => {
      const missing = await fetch(`${baseUrl}/api/auth/me`)
      assert.equal(missing.status, 401)

      const malformed = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { cookie: 'rq_session=not-a-jwt' },
      })
      assert.equal(malformed.status, 401)

      const expiredToken = jwt.sign(
        { sub: '507f1f77bcf86cd799439011' },
        process.env.AUTH_JWT_SECRET,
        {
          algorithm: 'HS256',
          expiresIn: -1,
          issuer: 'reliable-job-queue',
          audience: 'reliable-job-queue-client',
        },
      )
      const expired = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { cookie: `rq_session=${expiredToken}` },
      })
      assert.equal(expired.status, 401)
    })

    test('current-user endpoint returns only the authenticated user profile', async () => {
      const { response } = await register()
      const sessionCookie = setCookieValues(response)
        .find((value) => value.startsWith('rq_session='))
        .split(';')[0]
      const current = await fetch(`${baseUrl}/api/auth/me`, {
        headers: { cookie: sessionCookie },
      })
      const result = await current.json()

      assert.equal(current.status, 200)
      assert.equal(result.data.user.email, 'operator@example.test')
      assert.equal('passwordHash' in result.data.user, false)
    })

    test('state-changing auth requests require a CSRF cookie/header pair', async () => {
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Queue Operator',
          email: 'operator@example.test',
          password: 'secure-password-123',
        }),
      })
      assert.equal(response.status, 403)
    })
  },
)

function setCookieValues(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    return response.headers.getSetCookie().map((value) => value.split(';')[0])
  }
  return (response.headers.get('set-cookie') || '')
    .split(/, (?=[^;]+=)/)
    .map((value) => value.split(';')[0])
    .filter(Boolean)
}
