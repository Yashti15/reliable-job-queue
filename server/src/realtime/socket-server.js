import { Server as SocketIOServer } from 'socket.io'
import User from '../models/user.model.js'
import QueueEvent from '../models/queue-event.model.js'
import { sessionCookieName, verifySession } from '../auth/session.js'

function allowedOrigins() {
  const configured = process.env.CLIENT_ORIGIN
  if (configured !== undefined) {
    return new Set(configured.split(',').map((origin) => origin.trim()).filter(Boolean))
  }
  return null
}

function isAllowedOrigin(origin, configuredOrigins) {
  if (!origin) return true
  if (configuredOrigins) return configuredOrigins.has(origin)
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

function getCookie(cookieHeader, name) {
  for (const item of cookieHeader?.split(';') ?? []) {
    const [key, ...valueParts] = item.trim().split('=')
    if (key === name) return decodeURIComponent(valueParts.join('='))
  }
  return undefined
}

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

async function resolveSocketUser(token, UserModel) {
  const claims = verifySession(token)
  const user = await UserModel.findById(claims.sub).select('_id').lean()
  return user ? { userId: String(user._id), expiresAt: claims.exp * 1000 } : null
}

export function createSocketServer(
  httpServer,
  {
    EventModel = QueueEvent,
    UserModel = User,
    logger = console,
    resolveUser = (token) => resolveSocketUser(token, UserModel),
  } = {},
) {
  const origins = allowedOrigins()
  const io = new SocketIOServer(httpServer, {
    maxHttpBufferSize: 64 * 1024,
    cors: {
      origin(origin, callback) {
        callback(null, isAllowedOrigin(origin, origins))
      },
      credentials: true,
    },
  })

  io.use(async (socket, next) => {
    const token = getCookie(socket.request.headers.cookie, sessionCookieName)
    if (!token) {
      next(new Error('Authentication required.'))
      return
    }

    let user
    try {
      user = await resolveUser(token)
    } catch (error) {
      if (
        ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(
          error instanceof Error ? error.name : '',
        )
      ) {
        next(new Error('Authentication required.'))
        return
      }
      logger.error(`Socket session lookup failed (${safeErrorName(error)}).`)
      next(new Error('Authentication temporarily unavailable.'))
      return
    }
    if (!user || user.expiresAt <= Date.now()) {
      next(new Error('Authentication required.'))
      return
    }
    socket.data.userId = user.userId
    socket.data.sessionExpiresAt = user.expiresAt
    next()
  })

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.userId}`)
    const disconnectTimer = setTimeout(
      () => socket.disconnect(true),
      Math.max(0, socket.data.sessionExpiresAt - Date.now()),
    )
    socket.once('disconnect', () => clearTimeout(disconnectTimer))
    logger.info(`Dashboard socket connected (${socket.id}).`)
  })

  const bridge = startEventBridge(io, { EventModel, logger })
  return { io, bridge }
}

export function startEventBridge(
  io,
  {
    EventModel = QueueEvent,
    logger = console,
    pollingIntervalMs = 250,
    batchSize = 100,
  } = {},
) {
  let cursor
  let timer
  let stopped = false
  let activePoll

  async function poll() {
    if (stopped) return
    activePoll = (async () => {
      try {
        let hasFullBatch
        do {
          const events = await EventModel.find(cursor ? { _id: { $gt: cursor } } : {})
            .sort({ _id: 1 })
            .limit(batchSize)
            .lean()
          for (const event of events) {
            cursor = event._id
            if (event.ownerId) {
              io.to(`user:${String(event.ownerId)}`).emit(event.name, event.data)
            }
          }
          hasFullBatch = events.length === batchSize
        } while (hasFullBatch && !stopped)
      } catch (error) {
        const name = error instanceof Error ? error.name : 'UnknownError'
        logger.error(`Socket event bridge polling failed (${name}).`)
      }
    })()
    await activePoll
    activePoll = undefined
    if (!stopped) {
      timer = setTimeout(() => void poll(), pollingIntervalMs)
    }
  }

  const ready = (async () => {
    const latest = await EventModel.findOne({})
      .sort({ _id: -1 })
      .select({ _id: 1 })
      .lean()
    cursor = latest?._id
    await poll()
  })()

  return {
    ready,
    async stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      if (activePoll) await activePoll
      await ready
    },
  }
}
