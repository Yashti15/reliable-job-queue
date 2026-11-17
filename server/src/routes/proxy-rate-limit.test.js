import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { rateLimit } from 'express-rate-limit'
import app, { resolveTrustProxy } from '../app.js'
import { authRateLimit } from './auth.routes.js'

test('resolveTrustProxy configures single trusted proxy hop and never blindly trusts true', () => {
  assert.equal(resolveTrustProxy(undefined), 1, 'Default must be 1 proxy hop for Render')
  assert.equal(resolveTrustProxy(''), 1, 'Empty string must fall back to 1')
  assert.equal(resolveTrustProxy('   '), 1, 'Whitespace string must fall back to 1')
  assert.equal(resolveTrustProxy('1'), 1, 'Integer string 1 must parse to 1')
  assert.equal(resolveTrustProxy('2'), 2, 'Integer string 2 must parse to 2')
  assert.equal(resolveTrustProxy('true'), 1, 'Must not blindly trust all proxies when true is passed')
  assert.equal(resolveTrustProxy('invalid'), 1, 'Invalid string must fall back to 1')
  assert.equal(resolveTrustProxy('false'), false, 'false must disable trust proxy')
  assert.equal(resolveTrustProxy('0'), false, '0 must disable trust proxy')
})

test('Express app initializes trust proxy to 1 before request processing', () => {
  assert.equal(app.get('trust proxy'), 1, "Express 'trust proxy' must be set to 1 for Render reverse proxy")
  assert.notEqual(app.get('trust proxy'), true, "Express 'trust proxy' must never be true")
  assert.notEqual(app.get('trust proxy'), false, "Express 'trust proxy' must not be false behind reverse proxy")
})

test('Express correctly resolves client IP and rejects spoofed headers with trust proxy: 1', () => {
  function createProxiedRequest(forwardedHeader, socketIp = '10.0.0.1') {
    const req = {
      app,
      headers: forwardedHeader ? { 'x-forwarded-for': forwardedHeader } : {},
      socket: { remoteAddress: socketIp },
      connection: { remoteAddress: socketIp },
      path: '/api/auth/login',
      method: 'POST',
    }
    Object.setPrototypeOf(req, express.request)
    return req
  }

  // 1. Single hop from Render reverse proxy
  const singleHopReq = createProxiedRequest('203.0.113.195')
  assert.equal(singleHopReq.ip, '203.0.113.195', 'req.ip must derive the client IP from single proxy hop')

  // 2. Client attempt to spoof X-Forwarded-For with multiple IPs
  // Render appends the real client IP on the right: "spoofed_ip, real_client_ip"
  const spoofedReq = createProxiedRequest('198.51.100.1, 203.0.113.195')
  assert.equal(
    spoofedReq.ip,
    '203.0.113.195',
    'req.ip must derive the first untrusted IP from the right and ignore spoofed left-most entries',
  )

  // 3. Request without X-Forwarded-For falls back to direct socket IP
  const directReq = createProxiedRequest(null, '127.0.0.1')
  assert.equal(directReq.ip, '127.0.0.1', 'req.ip must fall back to socket remoteAddress when header is absent')
})

test('authRateLimit executes cleanly with X-Forwarded-For header without throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR', async () => {
  const req = {
    app,
    headers: { 'x-forwarded-for': '203.0.113.50' },
    socket: { remoteAddress: '10.0.0.1' },
    connection: { remoteAddress: '10.0.0.1' },
    path: '/api/auth/login',
    method: 'POST',
  }
  Object.setPrototypeOf(req, express.request)

  const headers = {}
  const res = {
    setHeader(key, value) {
      headers[key.toLowerCase()] = value
    },
    getHeader(key) {
      return headers[key.toLowerCase()]
    },
    status() {
      return this
    },
    send() {},
    json() {},
  }

  await new Promise((resolve, reject) => {
    try {
      authRateLimit(req, res, (err) => {
        if (err) reject(err)
        else resolve()
      })
    } catch (err) {
      reject(err)
    }
  })

  assert.equal(req.ip, '203.0.113.50')
  assert.ok(headers['ratelimit-limit'], 'RateLimit-Limit header must be present')
  assert.ok(headers['ratelimit-remaining'], 'RateLimit-Remaining header must be present')
})

test('rate limiting correctly tracks and isolates requests by proxy-derived client IP', async () => {
  const isolatedApp = express()
  isolatedApp.set('trust proxy', 1)

  const testLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 2,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
      success: false,
      error: { code: 'AUTH_RATE_LIMITED', message: 'Too many authentication attempts.' },
    },
  })

  function makeMock(ip) {
    const req = {
      app: isolatedApp,
      headers: { 'x-forwarded-for': ip },
      socket: { remoteAddress: '10.0.0.1' },
      connection: { remoteAddress: '10.0.0.1' },
      path: '/api/auth/login',
      method: 'POST',
    }
    Object.setPrototypeOf(req, express.request)

    const headers = {}
    let statusCode = 200
    let responseBody = null
    let onDone = () => {}

    const res = {
      setHeader(key, value) {
        headers[key.toLowerCase()] = value
      },
      getHeader(key) {
        return headers[key.toLowerCase()]
      },
      status(code) {
        statusCode = code
        return this
      },
      send(body) {
        responseBody = body
        onDone()
      },
      json(body) {
        responseBody = body
        onDone()
      },
    }

    return {
      req,
      res,
      setDone: (fn) => {
        onDone = fn
      },
      getStatus: () => statusCode,
      getBody: () => responseBody,
    }
  }

  const callLimiter = (mock) =>
    new Promise((resolve) => {
      mock.setDone(resolve)
      testLimiter(mock.req, mock.res, () => {
        resolve()
      })
    })

  // IP A: request 1 (allowed)
  const a1 = makeMock('198.51.100.10')
  await callLimiter(a1)
  assert.equal(a1.getStatus(), 200)

  // IP A: request 2 (allowed)
  const a2 = makeMock('198.51.100.10')
  await callLimiter(a2)
  assert.equal(a2.getStatus(), 200)

  // IP A: request 3 (rate limited: 429)
  const a3 = makeMock('198.51.100.10')
  await callLimiter(a3)
  assert.equal(a3.getStatus(), 429)
  assert.equal(a3.getBody()?.error?.code, 'AUTH_RATE_LIMITED')

  // IP B: request 1 (must be allowed, demonstrating IP isolation)
  const b1 = makeMock('198.51.100.20')
  await callLimiter(b1)
  assert.equal(b1.getStatus(), 200, 'Different client IP must have separate rate limit bucket')
})
