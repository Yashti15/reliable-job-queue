import dotenv from 'dotenv'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'
import mongoose from 'mongoose'
import { connectDatabase } from '../config/db.js'
import {
  assertArtifactCleanupSafety,
  cleanupArtifacts,
} from './artifact-cleanup.js'

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

function parseNumber(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : defaultValue
}

export function parseCleanupArguments(args) {
  const allowedArguments = new Set(['--dry-run', '--confirm'])
  const unknownArguments = args.filter((argument) => !allowedArguments.has(argument))
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown cleanup option: ${unknownArguments[0]}`)
  }
  if (args.includes('--dry-run') && args.includes('--confirm')) {
    throw new Error('Use either --dry-run or --confirm, not both.')
  }

  const confirm = args.includes('--confirm')
  return { confirm, dryRun: !confirm }
}

export async function runCleanup({
  args = process.argv.slice(2),
  env = process.env,
  connect = connectDatabase,
  disconnect = () => mongoose.disconnect(),
  cleanup = cleanupArtifacts,
  logger = console,
} = {}) {
  const { confirm, dryRun } = parseCleanupArguments(args)
  const targetEnvironment =
    String(env.NODE_ENV ?? 'unspecified').trim().toLowerCase() || 'unspecified'
  const targetIdentity = env.ARTIFACT_CLEANUP_TARGET_ID
  assertArtifactCleanupSafety({
    confirm,
    targetEnvironment,
    databaseUri: env.MONGODB_URI,
    targetIdentity,
  })

  const retentionDays = parseNumber(env.ARTIFACT_RETENTION_DAYS, 30)
  const orphanGraceHours = parseNumber(env.ORPHAN_GRACE_HOURS, 1)
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000
  const orphanGracePeriodMs = orphanGraceHours * 60 * 60 * 1000

  logger.log(
    `Starting artifact cleanup (environment: ${targetEnvironment}, retention: ${retentionDays}d, orphan grace: ${orphanGraceHours}h, mode: ${dryRun ? 'dry-run' : 'confirmed deletion'}).`,
  )

  await connect({ autoIndex: false, autoCreate: false })
  try {
    const summary = await cleanup({
      retentionMs,
      orphanGracePeriodMs,
      dryRun,
      confirm,
      targetEnvironment,
      databaseUri: env.MONGODB_URI,
      targetIdentity,
      beforeDelete: ({ artifactCount }) => {
        logger.log(
          `Confirmed artifact deletion: target environment "${targetEnvironment}", ${artifactCount} artifact(s).`,
        )
      },
      logger,
    })
    logger.log(
      dryRun
        ? `Dry-run complete: ${summary.candidates.length} artifact(s) would be deleted; scanned ${summary.scannedFiles} files, including ${summary.orphanFilesDeleted} orphan files and ${summary.expiredAssetsDeleted} expired assets; ${(summary.bytesReclaimed / 1024).toFixed(1)} KB would be reclaimed.`
        : `Cleanup finished: scanned ${summary.scannedFiles} files, deleted ${summary.orphanFilesDeleted} orphan files and ${summary.expiredAssetsDeleted} expired assets, reclaimed ${(summary.bytesReclaimed / 1024).toFixed(1)} KB.`,
    )
    if (summary.errors.length > 0) {
      logger.warn(`Cleanup encountered ${summary.errors.length} error(s).`)
    }
    return summary
  } finally {
    await disconnect()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCleanup()
    .then((summary) => {
      if (summary.errors.length > 0) process.exitCode = 1
    })
    .catch((error) => {
      console.error('Artifact cleanup failed:', error.message)
      process.exitCode = 1
    })
}
