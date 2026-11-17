import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import jwt from 'jsonwebtoken'
import {
  signSession,
  signSocketToken,
  validateAuthConfiguration,
  verifySession,
  verifySocketToken,
} from './session.js'

const originalJwtSecret = process.env.AUTH_JWT_SECRET
const originalClientOrigin = process.env.CLIENT_ORIGIN
const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  restore('AUTH_JWT_SECRET', originalJwtSecret)
  restore('CLIENT_ORIGIN', originalClientOrigin)
  restore('NODE_ENV', originalNodeEnv)
})

test('session configuration requires a strong secret', () => {
  delete process.env.AUTH_JWT_SECRET
  delete process.env.CLIENT_ORIGIN
  assert.throws(validateAuthConfiguration, /at least 32 bytes/)

  process.env.AUTH_JWT_SECRET = 'short'
  delete process.env.CLIENT_ORIGIN
  assert.throws(validateAuthConfiguration, /at least 32 bytes/)
})

test('production requires explicit HTTPS exact origins', () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  process.env.NODE_ENV = 'production'
  delete process.env.CLIENT_ORIGIN
  assert.throws(validateAuthConfiguration, /CLIENT_ORIGIN must be configured/)

  process.env.CLIENT_ORIGIN = 'http://dashboard.example.test'
  assert.throws(validateAuthConfiguration, /production origins must use HTTPS/)

  process.env.CLIENT_ORIGIN = 'https://dashboard.example.test/'
  assert.throws(validateAuthConfiguration, /exact origins/)

  process.env.CLIENT_ORIGIN = 'https://dashboard.example.test'
  assert.doesNotThrow(validateAuthConfiguration)
})

test('socket tickets cannot be used as normal session login tokens', () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  const socketToken = signSocketToken('user-123')
  assert.throws(() => verifySession(socketToken), /jwt audience invalid/)
})

test('verifySocketToken accepts socket tickets and session tokens for local/prod compatibility', () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  const socketToken = signSocketToken('user-123', Math.floor(Date.now() / 1000) + 1800)
  const socketClaims = verifySocketToken(socketToken)
  assert.equal(socketClaims.sub, 'user-123')
  assert.ok(socketClaims.sessionExp > 0)

  const sessionToken = signSession('user-456')
  const sessionClaims = verifySocketToken(sessionToken)
  assert.equal(sessionClaims.sub, 'user-456')
})

test('verifySocketToken rejects expired and malformed tokens', () => {
  process.env.AUTH_JWT_SECRET = 'test-secret-with-at-least-thirty-two-bytes'
  assert.throws(() => verifySocketToken('malformed.token.value'), /invalid token|jwt malformed/)

  const expiredToken = jwt.sign({ sub: 'user-expired' }, process.env.AUTH_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: -1,
    issuer: 'reliable-job-queue',
    audience: 'reliable-job-queue-socket',
  })
  assert.throws(() => verifySocketToken(expiredToken), /jwt expired/)
})

function restore(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
