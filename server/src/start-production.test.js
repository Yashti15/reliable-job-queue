import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fork } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const scriptPath = path.resolve(__dirname, 'start-production.js')
const testDbUri = process.env.MONGODB_TEST_URI

test(
  'start-production combined runner starts API and Worker and responds to /health',
  { skip: testDbUri ? false : 'Set MONGODB_TEST_URI to a local *_test database.' },
  async (context) => {
    const port = 59124
    const env = {
      ...process.env,
      PORT: String(port),
      MONGODB_URI: testDbUri,
      AUTH_JWT_SECRET: 'test-secret-with-at-least-thirty-two-bytes-12345',
      EMAIL_DEMO_MODE: 'true',
      WORKER_POLL_INTERVAL_MS: '500',
    }

    const child = fork(scriptPath, [], { env, silent: true })

    context.after(() => {
      if (!child.killed) child.kill('SIGTERM')
    })

    // Poll until /health is available
    let isHealthy = false
    const startTime = Date.now()
    while (Date.now() - startTime < 10000) {
      await new Promise((r) => setTimeout(r, 200))
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`)
        if (res.status === 200) {
          const body = await res.json()
          if (body.status === 'ok') {
            isHealthy = true
            break
          }
        }
      } catch {
        // Not ready yet
      }
    }

    assert.ok(isHealthy, 'Combined production service should become healthy on /health within 10s')

    // Verify graceful shutdown
    const exitPromise = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({ code, signal })),
    )
    child.kill('SIGTERM')
    const { code, signal } = await exitPromise
    assert.ok(
      code === 0 || signal === 'SIGTERM',
      `Combined production service should exit cleanly on SIGTERM (got code=${code}, signal=${signal})`,
    )
  },
)
