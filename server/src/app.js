import cors from 'cors'
import express from 'express'
import cookieParser from 'cookie-parser'
import helmet from 'helmet'
import authRoutes from './routes/auth.routes.js'
import healthRoutes from './routes/health.routes.js'
import jobsRoutes from './routes/jobs.routes.js'
import analyticsRoutes from './routes/analytics.routes.js'
import workersRoutes from './routes/workers.routes.js'
import uploadsRoutes from './routes/uploads.routes.js'
import { authenticate } from './auth/auth.middleware.js'
import { requireCsrf } from './auth/csrf.js'

const app = express()

function allowedOrigins() {
  const configured = process.env.CLIENT_ORIGIN
  if (configured !== undefined) {
    return new Set(configured.split(',').map((origin) => origin.trim()).filter(Boolean))
  }
  if (process.env.NODE_ENV === 'production') return new Set()
  return new Set(['http://localhost:5173', 'http://127.0.0.1:5173'])
}

app.use(helmet())
app.use(
  cors({
    credentials: true,
    origin(origin, callback) {
      if (!origin || allowedOrigins().has(origin)) {
        callback(null, true)
      } else {
        callback(null, false)
      }
    },
  }),
)
app.use(express.json({ limit: '100kb' }))
app.use(cookieParser())
app.use('/api/auth', authRoutes)
app.use('/health', healthRoutes)
app.use('/api/health', healthRoutes)
app.use('/api/jobs', authenticate, requireCsrf, jobsRoutes)
app.use(
  '/api/uploads',
  authenticate,
  requireCsrf,
  express.raw({ type: 'image/*', limit: '5mb' }),
  uploadsRoutes,
)
app.use('/api/analytics', authenticate, analyticsRoutes)
app.use('/api/workers', authenticate, workersRoutes)
app.use((error, _request, response, next) => {
  if (response.headersSent) {
    next(error)
    return
  }
  const status = error?.status === 413 ? 413 : error?.status === 400 ? 400 : 500
  const name =
    error instanceof Error && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
      ? error.name
      : 'UnknownError'
  console.error(`Request parsing failed (${name}).`)
  response.status(status).json({
    success: false,
    error: {
      code: status === 413 ? 'REQUEST_TOO_LARGE' : status === 400 ? 'INVALID_REQUEST_BODY' : 'INTERNAL_ERROR',
      message:
        status === 413
          ? 'Request body exceeds the allowed size.'
          : status === 400
            ? 'Request body is invalid.'
            : 'The request could not be completed.',
    },
  })
})

export default app
