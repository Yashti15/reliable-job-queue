import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import Job from '../models/job.model.js'
import User from '../models/user.model.js'

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

async function assignLegacyJobOwner() {
  if (process.env.ALLOW_TENANT_INDEX_MIGRATION !== '1') {
    throw new Error('Set ALLOW_TENANT_INDEX_MIGRATION=1 to confirm this local data migration.')
  }
  const uri = process.env.MONGODB_URI?.trim()
  if (!uri) throw new Error('MONGODB_URI must point to a local development database.')
  assertLocalDevelopmentTarget(uri)

  const jobId = process.env.LEGACY_JOB_ID
  const ownerId = process.env.LEGACY_OWNER_ID
  if (!mongoose.isObjectIdOrHexString(jobId) || !mongoose.isObjectIdOrHexString(ownerId)) {
    throw new Error('LEGACY_JOB_ID and LEGACY_OWNER_ID must be valid MongoDB ObjectIds.')
  }
  const jobObjectId = new mongoose.Types.ObjectId(jobId)
  const ownerObjectId = new mongoose.Types.ObjectId(ownerId)

  await mongoose.connect(uri)
  try {
    if (!(await User.exists({ _id: ownerObjectId }))) {
      throw new Error('The requested owner does not exist.')
    }

    const job = await Job.findById(jobObjectId).select('ownerId').lean()
    if (!job) throw new Error('The requested legacy job does not exist.')
    if (job.ownerId && String(job.ownerId) !== String(ownerObjectId)) {
      throw new Error('The requested job is already assigned to a different owner.')
    }
    if (job.ownerId) {
      console.log('The job is already assigned to the requested owner; no change was needed.')
      return
    }

    const result = await Job.updateOne(
      { _id: jobObjectId, ownerId: null },
      { $set: { ownerId: ownerObjectId } },
      { runValidators: true },
    )
    if (result.modifiedCount !== 1) {
      throw new Error('The legacy job changed during assignment; inspect it and retry.')
    }
    console.log('The selected legacy job was assigned to the requested owner.')
  } finally {
    await mongoose.disconnect()
  }
}

assignLegacyJobOwner().catch(async (error) => {
  console.error(
    `Legacy job owner assignment failed (${error instanceof Error ? error.name : 'UnknownError'}).`,
  )
  await mongoose.disconnect().catch(() => {})
  process.exitCode = 1
})
