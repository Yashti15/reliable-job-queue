import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseCleanupArguments,
  runCleanup,
} from './run-cleanup.js'
import { assertArtifactCleanupSafety } from './artifact-cleanup.js'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/db.js'

const emptySummary = {
  scannedFiles: 0,
  orphanFilesDeleted: 0,
  expiredAssetsDeleted: 0,
  bytesReclaimed: 0,
  dryRun: true,
  candidates: [],
  errors: [],
}

test('cleanup command defaults to dry-run without confirmation', () => {
  assert.deepEqual(parseCleanupArguments([]), {
    confirm: false,
    dryRun: true,
  })
})

test('cleanup command rejects conflicting and unknown options', () => {
  assert.throws(
    () => parseCleanupArguments(['--confirm', '--dry-run']),
    /not both/,
  )
  assert.throws(
    () => parseCleanupArguments(['--force']),
    /Unknown cleanup option/,
  )
})

test('confirmed cleanup requires an explicit matching development database identity', () => {
  assert.doesNotThrow(() =>
    assertArtifactCleanupSafety({
      confirm: true,
      targetEnvironment: 'development',
      databaseUri: 'mongodb://127.0.0.1:27017/reliable_job_queue_dev',
      targetIdentity: 'reliable_job_queue_dev',
    }),
  )
  assert.throws(
    () =>
      assertArtifactCleanupSafety({
        confirm: true,
        targetEnvironment: 'development',
        databaseUri:
          'mongodb://127.0.0.1:27017,remote.example:27017/reliable_job_queue_dev',
        targetIdentity: 'reliable_job_queue_dev',
      }),
    /restricted to loopback MongoDB/,
  )
  assert.throws(
    () =>
      assertArtifactCleanupSafety({
        confirm: true,
        targetEnvironment: 'development',
        databaseUri: 'mongodb://127.0.0.1:27017/reliable_job_queue_dev',
        targetIdentity: 'other_database',
      }),
    /exactly match/,
  )
  assert.throws(
    () =>
      assertArtifactCleanupSafety({
        confirm: true,
        targetEnvironment: 'test',
        databaseUri: 'mongodb://127.0.0.1:27017/reliable_job_queue',
        targetIdentity: 'reliable_job_queue',
      }),
    /development\/test database name/,
  )
})

test('confirmed cleanup rejects Atlas URIs', () => {
  assert.throws(
    () =>
      assertArtifactCleanupSafety({
        confirm: true,
        targetEnvironment: 'test',
        databaseUri: 'mongodb+srv://cluster.example/reliable_job_queue_test',
        targetIdentity: 'reliable_job_queue_test',
      }),
    /requires a local MongoDB URI/,
  )
})

test('cleanup database connection disables automatic index and collection creation', async () => {
  const originalConnect = mongoose.connect
  const originalUri = process.env.MONGODB_URI
  const originalLog = console.log
  let receivedOptions
  try {
    process.env.MONGODB_URI = 'mongodb://127.0.0.1:27017/reliable_job_queue_test'
    mongoose.connect = async (_uri, options) => {
      receivedOptions = options
      return mongoose
    }
    console.log = () => {}

    await connectDatabase({ autoIndex: false, autoCreate: false })
  } finally {
    mongoose.connect = originalConnect
    console.log = originalLog
    if (originalUri === undefined) delete process.env.MONGODB_URI
    else process.env.MONGODB_URI = originalUri
  }

  assert.equal(receivedOptions.autoIndex, false)
  assert.equal(receivedOptions.autoCreate, false)
})

test('cleanup command without --confirm runs read-only cleanup', async () => {
  let receivedOptions
  let connectionOptions
  await runCleanup({
    args: [],
    env: { NODE_ENV: 'development' },
    connect: async (options) => {
      connectionOptions = options
    },
    disconnect: async () => {},
    cleanup: async (options) => {
      receivedOptions = options
      return emptySummary
    },
    logger: { log() {}, warn() {} },
  })

  assert.equal(receivedOptions.dryRun, true)
  assert.equal(receivedOptions.confirm, false)
  assert.deepEqual(connectionOptions, { autoIndex: false, autoCreate: false })
})

test('production cleanup is blocked even with --confirm before connecting', async () => {
  let connected = false
  await assert.rejects(
    runCleanup({
      args: ['--confirm'],
      env: {
        NODE_ENV: 'production',
        MONGODB_URI: 'mongodb://127.0.0.1:27017/reliable_job_queue_test',
        ARTIFACT_CLEANUP_TARGET_ID: 'reliable_job_queue_test',
      },
      connect: async () => {
        connected = true
      },
      disconnect: async () => {},
      cleanup: async () => emptySummary,
      logger: { log() {}, warn() {} },
    }),
    /disabled in production/,
  )
  assert.equal(connected, false)
})

test('confirmed deletion reports environment and candidate count before cleanup', async () => {
  const output = []
  await runCleanup({
    args: ['--confirm'],
    env: {
      NODE_ENV: 'test',
      MONGODB_URI: 'mongodb://127.0.0.1:27017/reliable_job_queue_test',
      ARTIFACT_CLEANUP_TARGET_ID: 'reliable_job_queue_test',
    },
    connect: async () => {},
    disconnect: async () => {},
    cleanup: async (options) => {
      options.beforeDelete({ targetEnvironment: 'test', artifactCount: 2 })
      output.push('deletion-started')
      return { ...emptySummary, dryRun: false, candidates: [{}, {}] }
    },
    logger: { log: (message) => output.push(message), warn() {} },
  })

  const confirmationLine = output.findIndex((entry) =>
    String(entry).includes('target environment "test", 2 artifact(s)'),
  )
  assert.notEqual(confirmationLine, -1)
  assert.ok(confirmationLine < output.indexOf('deletion-started'))
})

test('confirmed cleanup requires an explicitly safe target environment', async () => {
  let connected = false
  await assert.rejects(
    runCleanup({
      args: ['--confirm'],
      env: {},
      connect: async () => {
        connected = true
      },
      disconnect: async () => {},
      cleanup: async () => emptySummary,
      logger: { log() {}, warn() {} },
    }),
    /requires NODE_ENV=development or NODE_ENV=test/,
  )
  assert.equal(connected, false)
})

test('confirmed cleanup refuses remote MongoDB even in development', async () => {
  let connected = false
  await assert.rejects(
    runCleanup({
      args: ['--confirm'],
      env: {
        NODE_ENV: 'development',
        MONGODB_URI: 'mongodb://example.invalid/reliable_job_queue_dev',
        ARTIFACT_CLEANUP_TARGET_ID: 'reliable_job_queue_dev',
      },
      connect: async () => {
        connected = true
      },
      disconnect: async () => {},
      cleanup: async () => emptySummary,
      logger: { log() {}, warn() {} },
    }),
    /restricted to loopback MongoDB/,
  )
  assert.equal(connected, false)
})
