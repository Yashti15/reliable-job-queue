import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getLeaseOptions } from './lease-config.js'

function withLeaseEnvironment(values, callback) {
  const names = ['WORKER_LEASE_DURATION_MS', 'WORKER_HEARTBEAT_INTERVAL_MS']
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))

  for (const name of names) {
    if (values[name] === undefined) {
      delete process.env[name]
    } else {
      process.env[name] = values[name]
    }
  }

  try {
    callback()
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = previous[name]
      }
    }
  }
}

test('lease configuration uses safe defaults', () => {
  withLeaseEnvironment({}, () => {
    assert.deepEqual(getLeaseOptions(), {
      leaseDurationMs: 30_000,
      heartbeatIntervalMs: 10_000,
    })
  })
})

test('lease configuration parses valid explicit values', () => {
  withLeaseEnvironment(
    {
      WORKER_LEASE_DURATION_MS: '12000',
      WORKER_HEARTBEAT_INTERVAL_MS: '4000',
    },
    () => {
      assert.deepEqual(getLeaseOptions(), {
        leaseDurationMs: 12_000,
        heartbeatIntervalMs: 4000,
      })
    },
  )
})

test('lease configuration rejects invalid values and unsafe heartbeat intervals', () => {
  withLeaseEnvironment(
    {
      WORKER_LEASE_DURATION_MS: '0',
      WORKER_HEARTBEAT_INTERVAL_MS: '1',
    },
    () => assert.throws(() => getLeaseOptions(), /WORKER_LEASE_DURATION_MS/),
  )
  withLeaseEnvironment(
    {
      WORKER_LEASE_DURATION_MS: '1000',
      WORKER_HEARTBEAT_INTERVAL_MS: '1000',
    },
    () => assert.throws(() => getLeaseOptions(), /must be shorter/),
  )
})
