import dotenv from 'dotenv'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import mongoose from 'mongoose'
import app from './app.js'
import { validateAuthConfiguration } from './auth/session.js'
import { connectDatabase } from './config/db.js'
import { createSocketServer } from './realtime/socket-server.js'
import { getLeaseOptions } from './worker/lease-config.js'
import { getRetryOptions } from './worker/retry-config.js'
import { startWorkerMonitor } from './worker/worker-monitor.js'
import { createWorker } from './worker/worker-runtime.js'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const port = Number(process.env.PORT) || 5000

function getPollInterval() {
  const configuredInterval = process.env.WORKER_POLL_INTERVAL_MS
  if (configuredInterval === undefined) return 2000
  if (!/^[1-9]\d*$/.test(configuredInterval)) {
    throw new Error('WORKER_POLL_INTERVAL_MS must be a positive integer.')
  }
  const interval = Number(configuredInterval)
  if (!Number.isSafeInteger(interval)) {
    throw new Error('WORKER_POLL_INTERVAL_MS must be a positive integer.')
  }
  return interval
}

async function startCombinedProductionService() {
  console.log('=== STARTING QUEUEOPS COMBINED PRODUCTION SERVICE (API + WORKER) ===')
  validateAuthConfiguration()
  await connectDatabase()

  // 1. Initialize API & Socket.IO
  const httpServer = createServer(app)
  const { io, bridge } = createSocketServer(httpServer)
  await bridge.ready

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, resolve)
  })
  console.log(`[API] Server and Socket.IO listening on port ${port}.`)

  // 2. Initialize Background Worker
  const pollIntervalMs = getPollInterval()
  const retryOptions = getRetryOptions()
  const leaseOptions = getLeaseOptions()

  const workerId =
    process.env.WORKER_ID?.trim() ||
    `worker-${os.hostname()}-${process.pid}-${randomUUID()}`
  if (workerId.length > 200) {
    throw new Error('WORKER_ID must be at most 200 characters.')
  }

  const monitor = await startWorkerMonitor({
    workerId,
    heartbeatIntervalMs: leaseOptions.heartbeatIntervalMs,
  })

  const worker = createWorker({
    workerId,
    pollIntervalMs,
    retryOptions,
    onStateChange: monitor.setCurrentJob,
    ...leaseOptions,
  })

  console.log(
    `[Worker] Background worker ${workerId} started; poll ${pollIntervalMs}ms, lease ${leaseOptions.leaseDurationMs}ms.`,
  )
  const workerPromise = worker.run()

  // 3. Graceful Shutdown Handler
  let isShuttingDown = false
  async function shutdown(signal) {
    if (isShuttingDown) return
    isShuttingDown = true
    console.log(`\nService received ${signal}; draining worker and stopping API...`)

    try {
      // Stop accepting new jobs and wait for in-flight job to drain
      worker.stop()
      await workerPromise.catch(() => {})
      await monitor.stop().catch(() => {})
      console.log('[Worker] Background worker drained and stopped.')

      // Stop realtime bridge and sockets
      await bridge.stop().catch(() => {})
      await new Promise((resolve) => io.close(resolve))
      console.log('[API] Socket.IO closed.')

      // Close HTTP server
      await new Promise((resolve) => httpServer.close(resolve))
      console.log('[API] HTTP server closed.')

      // Disconnect DB
      await mongoose.disconnect()
      console.log('[Database] MongoDB disconnected cleanly.')
      console.log('Production shutdown complete.')
      process.exit(0)
    } catch (shutdownError) {
      console.error('Error during graceful shutdown:', shutdownError)
      process.exit(1)
    }
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason)
  })
  process.on('uncaughtException', async (error) => {
    console.error('Uncaught exception:', error)
    await shutdown('uncaughtException').catch(() => {})
    process.exit(1)
  })
}

export { startCombinedProductionService }

const isDirectRun =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
if (isDirectRun || process.env.RUN_PRODUCTION_COMBINED === 'true') {
  startCombinedProductionService().catch((error) => {
    console.error('Unable to start combined production service:', error)
    process.exitCode = 1
  })
}
