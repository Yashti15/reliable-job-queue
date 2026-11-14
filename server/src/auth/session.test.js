import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { validateAuthConfiguration } from './session.js'

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

function restore(name, value) {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
