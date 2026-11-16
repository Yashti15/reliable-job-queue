import { randomBytes, timingSafeEqual } from 'node:crypto'
import { cookieOptions, csrfCookieName } from './session.js'

export function issueCsrfToken(response) {
  const token = randomBytes(32).toString('base64url')
  response.cookie(csrfCookieName, token, {
    ...cookieOptions(),
    httpOnly: false,
    maxAge: 30 * 60 * 1000,
  })
  return token
}

export function requireCsrf(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    next()
    return
  }
  const origin = request.get('origin')
  if (origin && !isAllowedOrigin(origin)) {
    response.status(403).json({
      success: false,
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed.' },
    })
    return
  }
  const cookieToken = request.cookies?.[csrfCookieName]
  const headerToken = request.get('x-csrf-token')
  if (
    typeof cookieToken !== 'string' ||
    typeof headerToken !== 'string' ||
    cookieToken.length !== headerToken.length ||
    !timingSafeEqual(Buffer.from(cookieToken), Buffer.from(headerToken))
  ) {
    response.status(403).json({
      success: false,
      error: { code: 'CSRF_INVALID', message: 'A valid CSRF token is required.' },
    })
    return
  }
  next()
}

function isAllowedOrigin(origin) {
  const configured = process.env.CLIENT_ORIGIN
  if (configured !== undefined) {
    return configured.split(',').map((value) => value.trim()).includes(origin)
  }
  if (process.env.NODE_ENV === 'production') return false
  try {
    const url = new URL(origin)
    return (
      ['localhost', '127.0.0.1'].includes(url.hostname) &&
      ['http:', 'https:'].includes(url.protocol)
    )
  } catch {
    return false
  }
}
