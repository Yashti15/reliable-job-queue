import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { rateLimit } from 'express-rate-limit'
import User from '../models/user.model.js'
import { authenticate } from '../auth/auth.middleware.js'
import { requireCsrf, issueCsrfToken } from '../auth/csrf.js'
import {
  clearSessionCookie,
  sessionCookieName,
  sessionCookieOptions,
  signSession,
} from '../auth/session.js'

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: { code: 'AUTH_RATE_LIMITED', message: 'Too many authentication attempts.' },
  },
})

function invalidCredentials(response) {
  response.status(401).json({
    success: false,
    error: { code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' },
  })
}

function safeUser(user) {
  return { id: String(user._id), name: user.name, email: user.email }
}

export function createAuthRouter({ UserModel = User, authenticateUser = authenticate } = {}) {
  const router = Router()

  router.get('/csrf', (_request, response) => {
    const csrfToken = issueCsrfToken(response)
    response.json({ success: true, data: { csrfToken } })
  })

  router.post('/register', requireCsrf, authRateLimit, async (request, response) => {
    const { name, email, password } = request.body ?? {}
    const unexpectedFields = Object.keys(request.body ?? {}).filter(
      (field) => !['name', 'email', 'password'].includes(field),
    )
    if (
      unexpectedFields.length > 0 ||
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 100 ||
      typeof email !== 'string' ||
      !emailPattern.test(email.trim()) ||
      email.trim().length > 254 ||
      typeof password !== 'string' ||
      password.length < 12 ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      response.status(400).json({
        success: false,
        error: {
          code: 'INVALID_REGISTRATION',
          message: 'Provide a name, valid email, and password of 12 to 72 UTF-8 bytes.',
        },
      })
      return
    }

    try {
      const normalizedEmail = email.trim().toLowerCase()
      const passwordHash = await bcrypt.hash(password, 12)
      const user = await UserModel.create({
        name: name.trim(),
        email: normalizedEmail,
        passwordHash,
      })
      response.cookie(sessionCookieName, signSession(user._id), sessionCookieOptions())
      response.status(201).json({ success: true, data: { user: safeUser(user) } })
    } catch (error) {
      if (error?.code === 11000 && error.keyPattern?.email) {
        response.status(409).json({
          success: false,
          error: { code: 'EMAIL_IN_USE', message: 'An account with this email already exists.' },
        })
        return
      }
      console.error(`Registration failed (${error instanceof Error ? error.name : 'UnknownError'}).`)
      response.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Registration could not be completed.' },
      })
    }
  })

  router.post('/login', requireCsrf, authRateLimit, async (request, response) => {
    const { email, password } = request.body ?? {}
    if (
      typeof email !== 'string' ||
      !emailPattern.test(email.trim()) ||
      email.trim().length > 254 ||
      typeof password !== 'string' ||
      !password ||
      Buffer.byteLength(password, 'utf8') > 72
    ) {
      invalidCredentials(response)
      return
    }

    try {
      const user = await UserModel.findOne({ email: email.trim().toLowerCase() })
        .select('+passwordHash')
      if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
        invalidCredentials(response)
        return
      }
      response.cookie(sessionCookieName, signSession(user._id), sessionCookieOptions())
      response.json({ success: true, data: { user: safeUser(user) } })
    } catch (error) {
      console.error(`Login failed (${error instanceof Error ? error.name : 'UnknownError'}).`)
      response.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'Login could not be completed.' },
      })
    }
  })

  router.get('/me', authenticateUser, (request, response) => {
    response.json({ success: true, data: { user: safeUser(request.authUser) } })
  })

  router.post('/logout', requireCsrf, (_request, response) => {
    clearSessionCookie(response)
    response.status(204).end()
  })

  return router
}

export default createAuthRouter()
