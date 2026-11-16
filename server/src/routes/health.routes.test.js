import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import app from '../app.js'

let server
let baseUrl

before(async () => {
  delete process.env.MONGODB_URI
  server = app.listen(0)
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
})

test('GET /api/health and /health report API and database status', async () => {
  const [apiHealth, rootHealth] = await Promise.all([
    fetch(`${baseUrl}/api/health`),
    fetch(`${baseUrl}/health`),
  ])

  assert.equal(apiHealth.status, 200)
  assert.equal(rootHealth.status, 200)
  const expected = {
    status: 'ok',
    service: 'reliable-job-queue-api',
    database: 'not_configured',
  }
  assert.deepEqual(await apiHealth.json(), expected)
  assert.deepEqual(await rootHealth.json(), expected)
})
