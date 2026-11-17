import jwt from 'jsonwebtoken'

export const sessionCookieName = 'rq_session'
export const csrfCookieName = 'rq_csrf'
export const sessionDurationSeconds = 30 * 60
export const socketTicketDurationSeconds = 120

export function validateAuthConfiguration() {
  jwtSecret()
  const configuredOrigins = process.env.CLIENT_ORIGIN
  if (configuredOrigins === undefined) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('CLIENT_ORIGIN must be configured in production.')
    }
    return
  }

  const origins = configuredOrigins.split(',').map((origin) => origin.trim())
  if (
    origins.some((origin) => {
      if (!origin) return true
      try {
        const parsed = new URL(origin)
        return (
          parsed.origin !== origin ||
          (process.env.NODE_ENV === 'production' && parsed.protocol !== 'https:')
        )
      } catch {
        return true
      }
    })
  ) {
    throw new Error(
      'CLIENT_ORIGIN must be a comma-separated list of exact origins; production origins must use HTTPS.',
    )
  }
}

function jwtSecret() {
  const secret = process.env.AUTH_JWT_SECRET
  if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
    throw new Error('AUTH_JWT_SECRET must contain at least 32 bytes.')
  }
  return secret
}

export function signSession(userId) {
  return jwt.sign({ sub: String(userId) }, jwtSecret(), {
    algorithm: 'HS256',
    expiresIn: sessionDurationSeconds,
    issuer: 'reliable-job-queue',
    audience: 'reliable-job-queue-client',
  })
}

export function verifySession(token) {
  return jwt.verify(token, jwtSecret(), {
    algorithms: ['HS256'],
    issuer: 'reliable-job-queue',
    audience: 'reliable-job-queue-client',
  })
}

export function signSocketToken(userId, sessionExpiresAt) {
  const payload = { sub: String(userId) }
  if (typeof sessionExpiresAt === 'number' && Number.isFinite(sessionExpiresAt)) {
    payload.sessionExp = Math.floor(sessionExpiresAt)
  }
  return jwt.sign(payload, jwtSecret(), {
    algorithm: 'HS256',
    expiresIn: socketTicketDurationSeconds,
    issuer: 'reliable-job-queue',
    audience: 'reliable-job-queue-socket',
  })
}

export function verifySocketToken(token) {
  return jwt.verify(token, jwtSecret(), {
    algorithms: ['HS256'],
    issuer: 'reliable-job-queue',
    audience: ['reliable-job-queue-socket', 'reliable-job-queue-client'],
  })
}

export function cookieOptions() {
  const sameSiteEnv = (process.env.COOKIE_SAME_SITE || 'strict').toLowerCase()
  const validSameSite = ['strict', 'lax', 'none'].includes(sameSiteEnv) ? sameSiteEnv : 'strict'
  const isSecure = validSameSite === 'none' || process.env.NODE_ENV === 'production'
  return {
    secure: isSecure,
    sameSite: validSameSite,
    path: '/',
  }
}

export function sessionCookieOptions() {
  return {
    ...cookieOptions(),
    httpOnly: true,
    maxAge: sessionDurationSeconds * 1000,
  }
}

export function clearSessionCookie(response) {
  response.clearCookie(sessionCookieName, {
    ...cookieOptions(),
    httpOnly: true,
  })
  response.clearCookie(csrfCookieName, cookieOptions())
}
