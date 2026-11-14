import mongoose from 'mongoose'
import User from '../models/user.model.js'
import { sessionCookieName, verifySession } from './session.js'

function findUserById(UserModel, id) {
  return UserModel.findById(id).select('_id name email')
}

function rejectAuthentication(response) {
  response.clearCookie(sessionCookieName, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/',
  })
  response.status(401).json({
    success: false,
    error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' },
  })
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

export function createAuthenticate({ UserModel = User } = {}) {
  return async function authenticate(request, response, next) {
    const token = request.cookies?.[sessionCookieName]
    if (!token) {
      rejectAuthentication(response)
      return
    }

    let claims
    try {
      claims = verifySession(token)
    } catch {
      rejectAuthentication(response)
      return
    }

    if (typeof claims.sub !== 'string' || !mongoose.isObjectIdOrHexString(claims.sub)) {
      rejectAuthentication(response)
      return
    }

    let user
    try {
      user = await findUserById(UserModel, claims.sub)
    } catch (error) {
      console.error(`Session lookup failed (${safeErrorName(error)}).`)
      response.status(503).json({
        success: false,
        error: {
          code: 'AUTH_UNAVAILABLE',
          message: 'Authentication is temporarily unavailable.',
        },
      })
      return
    }

    const safeUser = user?.toObject ? user.toObject() : user
    if (!safeUser) {
      rejectAuthentication(response)
      return
    }
    request.authUser = safeUser
    request.userId = safeUser._id
    next()
  }
}

export const authenticate = createAuthenticate()
