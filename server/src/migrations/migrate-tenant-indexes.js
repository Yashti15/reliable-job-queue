import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import Job from '../models/job.model.js'

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

function assertLocalDevelopmentTarget(uri) {
  const parsed = new URL(uri)
  const database = decodeURIComponent(parsed.pathname.slice(1))
  if (
    database.length > 63 ||
    parsed.protocol !== 'mongodb:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname.toLowerCase()) ||
    !/(?:_dev|_test)$/i.test(database)
  ) {
    throw new Error(
      'This migration script only runs against loopback MongoDB databases ending in _dev or _test.',
    )
  }
}

async function migrate() {
  if (process.env.ALLOW_TENANT_INDEX_MIGRATION !== '1') {
    throw new Error('Set ALLOW_TENANT_INDEX_MIGRATION=1 to confirm this local index migration.')
  }
  const uri = process.env.MONGODB_URI?.trim()
  if (!uri) throw new Error('MONGODB_URI must point to a local development database.')
  assertLocalDevelopmentTarget(uri)

  await mongoose.connect(uri)
  try {
    await Job.init()
    await Job.collection.createIndex(
      { ownerId: 1, idempotencyKey: 1 },
      {
        name: 'ownerId_1_idempotencyKey_1',
        unique: true,
        partialFilterExpression: {
          ownerId: { $type: 'objectId' },
          idempotencyKey: { $type: 'string' },
        },
      },
    )
    const indexes = await Job.collection.indexes()
    if (indexes.some((index) => index.name === 'idempotencyKey_1')) {
      await Job.collection.dropIndex('idempotencyKey_1')
    }
    const legacyCount = await Job.countDocuments({ ownerId: null })
    console.log(
      `Tenant idempotency index is ready. ${legacyCount} ownerless legacy jobs remain unchanged and unclaimable.`,
    )
  } finally {
    await mongoose.disconnect()
  }
}

migrate().catch(async (error) => {
  console.error(`Tenant index migration failed (${error instanceof Error ? error.name : 'UnknownError'}).`)
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})
