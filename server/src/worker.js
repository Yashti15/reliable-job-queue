import dotenv from 'dotenv'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import { connectDatabase } from './config/db.js'
import { createWorker } from './worker/worker-runtime.js'
import { getRetryOptions } from './worker/retry-config.js'
import { getLeaseOptions } from './worker/lease-config.js'
import { startWorkerMonitor } from './worker/worker-monitor.js'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

function getPollInterval() {
  const configuredInterval = process.env.WORKER_POLL_INTERVAL_MS
  if (configuredInterval === undefined) {
    return 2000
  }

  if (!/^[1-9]\d*$/.test(configuredInterval)) {
    throw new Error('WORKER_POLL_INTERVAL_MS must be a positive integer.')
  }

  const interval = Number(configuredInterval)
  if (!Number.isSafeInteger(interval)) {
    throw new Error('WORKER_POLL_INTERVAL_MS must be a positive integer.')
  }
  return interval
}

async function startWorker() {
  const pollIntervalMs = getPollInterval()
  const retryOptions = getRetryOptions()
  const leaseOptions = getLeaseOptions()
  await connectDatabase()

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

  process.once('SIGINT', () => {
    console.log('Worker received SIGINT; stopping after the current job.')
    worker.stop()
  })
  process.once('SIGTERM', () => {
    console.log('Worker received SIGTERM; stopping after the current job.')
    worker.stop()
  })

  console.log(
    `Worker ${workerId} started; poll interval ${pollIntervalMs}ms, lease ${leaseOptions.leaseDurationMs}ms, heartbeat ${leaseOptions.heartbeatIntervalMs}ms.`,
  )
  try {
    await worker.run()
  } finally {
    await monitor.stop()
    await mongoose.disconnect()
  }
  console.log('Worker shutdown complete.')
}

startWorker().catch(async (error) => {
  console.error(`Unable to start worker (${safeErrorName(error)}).`)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})
