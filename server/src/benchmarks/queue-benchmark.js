import { randomUUID } from 'node:crypto'
import express from 'express'
import mongoose from 'mongoose'
import Job from '../models/job.model.js'
import { createJobsRouter } from '../routes/jobs.routes.js'
import { connectToIsolatedMongoTestDatabase } from '../test-support/isolated-mongo.js'
import { claimNextJob, completeJob } from '../queue/job-queue.js'

function parseList(value, fallback, maxValue) {
  const parsed = (value ?? fallback)
    .split(',')
    .map((item) => Number(item.trim()))
  if (
    parsed.some(
      (item) => !Number.isSafeInteger(item) || item < 1 || item > maxValue,
    )
  ) {
    throw new Error(`Benchmark values must be positive integers no greater than ${maxValue}.`)
  }
  return parsed
}

function percentile(samples, ratio) {
  if (!samples.length) return 0
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * ratio) - 1]
}

async function runPool(count, concurrency, operation) {
  let nextIndex = 0
  await Promise.all(
    Array.from({ length: Math.min(count, concurrency) }, async () => {
      while (nextIndex < count) {
        const index = nextIndex
        nextIndex += 1
        await operation(index)
      }
    }),
  )
}

async function benchmarkCase(baseUrl, ownerId, volume, workerCount) {
  const runId = randomUUID()
  await Job.deleteMany({})
  const requestLatencyMs = []
  const submitStarted = performance.now()

  await runPool(volume, 16, async (index) => {
    const requestStarted = performance.now()
    const response = await fetch(`${baseUrl}/api/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'benchmark',
        payload: { runId, index },
      }),
    })
    if (response.status !== 201) {
      throw new Error(`Benchmark submission failed with HTTP ${response.status}.`)
    }
    requestLatencyMs.push(performance.now() - requestStarted)
  })

  const submissionDurationMs = performance.now() - submitStarted
  const queueLatencyMs = []
  const claimCompletionMs = []
  const drainStarted = performance.now()

  await Promise.all(
    Array.from({ length: workerCount }, async (_, workerIndex) => {
      const workerId = `benchmark-${runId}-${workerIndex}`
      while (true) {
        const job = await claimNextJob(workerId, {
          eventPublisher: async () => true,
        })
        if (!job) return

        queueLatencyMs.push(Math.max(0, Date.now() - job.createdAt.getTime()))
        const completionStarted = performance.now()
        const completed = await completeJob(
          job,
          workerId,
          new Date(),
          async () => true,
        )
        if (!completed) {
          throw new Error('Benchmark worker lost its claim before completion.')
        }
        claimCompletionMs.push(performance.now() - completionStarted)
      }
    }),
  )

  const drainDurationMs = performance.now() - drainStarted
  const completedCount = await Job.countDocuments({
    'payload.runId': runId,
    status: 'completed',
  })
  if (completedCount !== volume) {
    throw new Error(`Expected ${volume} completed jobs but found ${completedCount}.`)
  }

  return {
    volume,
    workerCount,
    submissionJobsPerSecond: Number(
      (volume / (submissionDurationMs / 1000)).toFixed(2),
    ),
    submissionRequestP95Ms: Number(percentile(requestLatencyMs, 0.95).toFixed(2)),
    claimCompletionJobsPerSecond: Number(
      (volume / (drainDurationMs / 1000)).toFixed(2),
    ),
    meanQueueLatencyMs: Number(
      (queueLatencyMs.reduce((sum, item) => sum + item, 0) / volume).toFixed(2),
    ),
    completionWriteP95Ms: Number(
      percentile(claimCompletionMs, 0.95).toFixed(2),
    ),
    completedCount,
  }
}

async function main() {
  const volumes = parseList(process.env.BENCH_JOB_VOLUMES, '100,500', 5000)
  const workerCounts = parseList(process.env.BENCH_WORKER_COUNTS, '1,4', 32)
  const closeDatabase = await connectToIsolatedMongoTestDatabase()
  let server
  try {
    await Job.init()
    const ownerId = new mongoose.Types.ObjectId()
    const app = express()
    app.use(express.json())
    app.use('/api/jobs', (request, _response, next) => {
      request.authUser = { _id: ownerId }
      next()
    })
    app.use(
      '/api/jobs',
      createJobsRouter(Job, { eventPublisher: async () => true }),
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })

    const results = []
    for (const volume of volumes) {
      for (const workerCount of workerCounts) {
        results.push(
          await benchmarkCase(
            `http://127.0.0.1:${server.address().port}`,
            ownerId,
            volume,
            workerCount,
          ),
        )
      }
    }
    console.log(
      JSON.stringify(
        {
          benchmark: 'local MongoDB REST submission and atomic claim/completion',
          database: 'isolated local *_test database',
          volumes,
          workerCounts,
          results,
        },
        null,
        2,
      ),
    )
  } finally {
    if (server) {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
    await closeDatabase()
  }
}

main().catch((error) => {
  console.error(`Queue benchmark failed (${error instanceof Error ? error.name : 'UnknownError'}).`)
  process.exitCode = 1
})
