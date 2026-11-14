import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/db.js'
import { cleanupArtifacts } from './artifact-cleanup.js'

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

function parseNumber(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : defaultValue
}

async function run() {
  const retentionDays = parseNumber(process.env.ARTIFACT_RETENTION_DAYS, 30)
  const orphanGraceHours = parseNumber(process.env.ORPHAN_GRACE_HOURS, 1)
  const dryRun = process.env.CLEANUP_DRY_RUN === 'true' || process.argv.includes('--dry-run')

  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  const orphanGracePeriodMs = orphanGraceHours * 60 * 60 * 1000

  console.log(
    `Starting artifact cleanup (retention: ${retentionDays}d, orphan grace: ${orphanGraceHours}h, dryRun: ${dryRun})...`,
  )

  await connectDatabase()
  try {
    const summary = await cleanupArtifacts({
      retentionMs,
      orphanGracePeriodMs,
      dryRun,
    })
    console.log(
      `Cleanup finished: scanned ${summary.scannedFiles} files, deleted ${summary.orphanFilesDeleted} orphan files, deleted ${summary.expiredAssetsDeleted} expired assets, reclaimed ${(summary.bytesReclaimed / 1024).toFixed(1)} KB.`,
    )
    if (summary.errors.length > 0) {
      console.warn(`Cleanup encountered ${summary.errors.length} non-fatal errors.`)
    }
  } finally {
    await mongoose.disconnect()
  }
}

run().catch((error) => {
  console.error('Artifact cleanup failed:', error.message)
  process.exitCode = 1
})
