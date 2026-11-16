import { lstat, readdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import JobAsset from '../models/job-asset.model.js'
import { fileStore } from './file-store.js'

const ownerIdPattern = /^[0-9a-f]{24}$/i
const storageKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|jpg|png|webp)$/

export function assertArtifactCleanupSafety({
  confirm,
  targetEnvironment,
  databaseUri,
  targetIdentity,
}) {
  if (!confirm) return

  const environment = String(targetEnvironment ?? '').trim().toLowerCase()
  if (['production', 'prod'].includes(environment)) {
    throw new Error('Artifact deletion is disabled in production.')
  }
  if (!['development', 'test'].includes(environment)) {
    throw new Error(
      'Confirmed artifact deletion requires NODE_ENV=development or NODE_ENV=test.',
    )
  }

  const databaseName = getSafeLocalDatabaseName(databaseUri)
  const databaseNameIsSafe =
    environment === 'test'
      ? /(^|[_-])test([_-]|$)/i.test(databaseName)
      : /(^|[_-])(?:dev|development)([_-]|$)/i.test(databaseName)
  if (!databaseNameIsSafe || targetIdentity !== databaseName) {
    throw new Error(
      'Confirmed artifact deletion requires ARTIFACT_CLEANUP_TARGET_ID to exactly match a development/test database name.',
    )
  }
}

export async function cleanupArtifacts({
  store = fileStore,
  AssetModel = JobAsset,
  retentionMs = 30 * 24 * 60 * 60 * 1000,
  orphanGracePeriodMs = 60 * 60 * 1000,
  dryRun,
  confirm = false,
  ownerId = null,
  now = () => new Date(),
  logger = console,
  targetEnvironment = process.env.NODE_ENV,
  databaseUri = process.env.MONGODB_URI,
  targetIdentity = process.env.ARTIFACT_CLEANUP_TARGET_ID,
  beforeDelete = async () => {},
} = {}) {
  const isDryRun = dryRun ?? !confirm
  if (!isDryRun && !confirm) {
    throw new Error('Artifact deletion requires explicit confirmation.')
  }
  assertArtifactCleanupSafety({
    confirm,
    targetEnvironment,
    databaseUri,
    targetIdentity,
  })
  if (ownerId && !ownerIdPattern.test(String(ownerId))) {
    throw new TypeError('Invalid artifact owner.')
  }

  const configuredRoot = path.resolve(store.root)
  let storageRoot
  try {
    const rootStats = await lstat(configuredRoot)
    if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
      throw new TypeError('Artifact storage root cannot be a symbolic link.')
    }
    storageRoot = await realpath(configuredRoot)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      storageRoot = configuredRoot
    } else {
      throw error
    }
  }
  const usersDir = path.join(storageRoot, 'users')
  const currentDate = now()
  const currentTime =
    currentDate instanceof Date && Number.isFinite(currentDate.getTime())
      ? currentDate.getTime()
      : Date.now()
  const candidates = new Map()

  const summary = {
    scannedFiles: 0,
    orphanFilesDeleted: 0,
    expiredAssetsDeleted: 0,
    bytesReclaimed: 0,
    dryRun: isDryRun,
    candidates: [],
    errors: [],
  }

  const usersDirectory = await readDirectorySafely(
    usersDir,
    storageRoot,
    summary.errors,
    'users',
  )
  const ownerEntries = usersDirectory?.entries ?? []

  for (const ownerEntry of ownerEntries) {
    if (ownerEntry.isSymbolicLink()) {
      summary.errors.push({
        ownerId: ownerEntry.name,
        message: 'Symbolic-link owner directories are not scanned.',
      })
      continue
    }
    if (!ownerEntry.isDirectory() || !ownerIdPattern.test(ownerEntry.name)) {
      continue
    }

    if (ownerId && ownerEntry.name !== String(ownerId)) {
      continue
    }

    const currentOwnerId = ownerEntry.name
    const ownerDirectory = await readDirectorySafely(
      path.join(usersDirectory.realPath, currentOwnerId),
      storageRoot,
      summary.errors,
      currentOwnerId,
    )
    if (!ownerDirectory) continue

    for (const category of ['uploads', 'outputs']) {
      const categoryDirectory = await readDirectorySafely(
        path.join(ownerDirectory.realPath, category),
        storageRoot,
        summary.errors,
        `${currentOwnerId}/${category}`,
      )
      if (!categoryDirectory) continue

      for (const fileEntry of categoryDirectory.entries) {
        if (fileEntry.isSymbolicLink()) {
          summary.errors.push({
            ownerId: currentOwnerId,
            category,
            file: fileEntry.name,
            message: 'Symbolic-link artifacts are not scanned.',
          })
          continue
        }
        if (!fileEntry.isFile() || !storageKeyPattern.test(fileEntry.name)) {
          continue
        }

        summary.scannedFiles += 1
        let fileStats
        try {
          fileStats = await store.stat(currentOwnerId, fileEntry.name, category)
        } catch (error) {
          if (error?.code === 'ENOENT') continue
          summary.errors.push({
            file: fileEntry.name,
            message: error.message,
          })
          continue
        }

        const fileAge = Math.max(0, currentTime - fileStats.mtimeMs)
        const assetRecord = await AssetModel.findOne({
          ownerId: currentOwnerId,
          storageKey: fileEntry.name,
        }).lean()

        if (!assetRecord) {
          if (fileAge >= orphanGracePeriodMs) {
            addCandidate(candidates, {
              type: 'orphan',
              ownerId: currentOwnerId,
              storageKey: fileEntry.name,
              category,
              sizeBytes: fileStats.size,
            })
          }
        } else {
          if (assetRecord.cleanupPending || fileAge >= retentionMs) {
            addCandidate(candidates, {
              type: 'expired_asset',
              ownerId: currentOwnerId,
              storageKey: fileEntry.name,
              category,
              assetId: assetRecord._id,
              cleanupPending: Boolean(assetRecord.cleanupPending),
              sizeBytes: fileStats.size,
            })
          }
        }
      }
    }
  }

  const trackedRecords = await AssetModel.find({
    $or: [
      { createdAt: { $lte: new Date(currentTime - retentionMs) } },
      { cleanupPending: true },
    ],
    ...(ownerId ? { ownerId } : {}),
  }).lean()

  for (const assetRecord of trackedRecords) {
    const currentOwnerId = String(assetRecord.ownerId)
    if (
      !ownerIdPattern.test(currentOwnerId) ||
      (ownerId && currentOwnerId !== String(ownerId))
    ) {
      continue
    }

    const category =
      assetRecord.kind === 'upload'
        ? 'uploads'
        : assetRecord.kind === 'output'
          ? 'outputs'
          : null
    if (!category || !storageKeyPattern.test(assetRecord.storageKey)) {
      summary.errors.push({
        ownerId: currentOwnerId,
        message: 'Expired asset metadata contains an invalid storage reference.',
      })
      continue
    }

    const candidateKey = `${currentOwnerId}:${assetRecord.storageKey}`
    if (candidates.has(candidateKey)) continue

    try {
      await store.stat(currentOwnerId, assetRecord.storageKey, category)
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        summary.errors.push({
          file: assetRecord.storageKey,
          message: error.message,
        })
        continue
      }

      addCandidate(candidates, {
        type: 'expired_asset',
        ownerId: currentOwnerId,
        storageKey: assetRecord.storageKey,
        category,
        assetId: assetRecord._id,
        cleanupPending: Boolean(assetRecord.cleanupPending),
        sizeBytes: 0,
      })
    }
  }

  summary.candidates = [...candidates.values()]
  if (isDryRun) {
    for (const candidate of summary.candidates) {
      addPlannedCounts(summary, candidate)
      logger?.info?.(
        `Would delete ${candidate.type}: ${candidate.ownerId}/${candidate.category}/${candidate.storageKey} (${candidate.sizeBytes} bytes).`,
      )
    }
    return summary
  }

  await beforeDelete({
    targetEnvironment,
    artifactCount: summary.candidates.length,
  })

  for (const candidate of summary.candidates) {
    let fileSize = 0
    if (candidate.type === 'expired_asset') {
      try {
        if (!candidate.cleanupPending) {
          const updateResult = await AssetModel.updateOne(
            {
              _id: candidate.assetId,
              ownerId: candidate.ownerId,
              storageKey: candidate.storageKey,
            },
            {
              $set: {
                cleanupPending: true,
                cleanupPendingAt: new Date(currentTime),
              },
            },
          )
          if (updateResult.matchedCount !== 1) {
            summary.errors.push({
              file: candidate.storageKey,
              message: 'Asset metadata changed before cleanup.',
            })
            continue
          }
        }
      } catch (error) {
        summary.errors.push({
          file: candidate.storageKey,
          message: error.message,
        })
        continue
      }

      try {
        fileSize = (await store.stat(
          candidate.ownerId,
          candidate.storageKey,
          candidate.category,
        )).size
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          summary.errors.push({
            file: candidate.storageKey,
            message: error.message,
          })
          continue
        }
      }

      try {
        await store.remove(
          candidate.ownerId,
          candidate.storageKey,
          candidate.category,
        )
      } catch (error) {
        summary.errors.push({
          file: candidate.storageKey,
          message: error.message,
        })
        continue
      }

      try {
        const result = await AssetModel.deleteOne({
          _id: candidate.assetId,
          ownerId: candidate.ownerId,
          storageKey: candidate.storageKey,
          cleanupPending: true,
        })
        if (result.deletedCount !== 1) {
          summary.errors.push({
            file: candidate.storageKey,
            message: 'Asset metadata changed before cleanup.',
          })
          continue
        }
      } catch (error) {
        summary.errors.push({
          file: candidate.storageKey,
          message: error.message,
        })
        continue
      }
    }

    if (candidate.type === 'orphan') {
      let fileSize = 0
      try {
        fileSize = (await store.stat(
          candidate.ownerId,
          candidate.storageKey,
          candidate.category,
        )).size
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          summary.errors.push({
            file: candidate.storageKey,
            message: error.message,
          })
          continue
        }
      }

      try {
        await store.remove(
          candidate.ownerId,
          candidate.storageKey,
          candidate.category,
        )
      } catch (error) {
        summary.errors.push({
          file: candidate.storageKey,
          message: error.message,
        })
        continue
      }
      summary.orphanFilesDeleted += 1
      summary.bytesReclaimed += fileSize
      logger?.info?.(
        `Deleted ${candidate.type}: ${candidate.ownerId}/${candidate.category}/${candidate.storageKey} (${fileSize} bytes).`,
      )
      continue
    }

    summary.bytesReclaimed += fileSize
    summary.expiredAssetsDeleted += 1
    logger?.info?.(
      `Deleted ${candidate.type}: ${candidate.ownerId}/${candidate.category}/${candidate.storageKey} (${fileSize} bytes).`,
    )
  }

  return summary
}

function addCandidate(candidates, candidate) {
  candidates.set(`${candidate.ownerId}:${candidate.storageKey}`, candidate)
}

function addPlannedCounts(summary, candidate) {
  if (candidate.type === 'orphan') {
    summary.orphanFilesDeleted += 1
  } else {
    summary.expiredAssetsDeleted += 1
  }
  summary.bytesReclaimed += candidate.sizeBytes
}

async function readDirectorySafely(directory, storageRoot, errors, label) {
  try {
    const directoryStats = await lstat(directory)
    if (
      directoryStats.isSymbolicLink() ||
      !directoryStats.isDirectory()
    ) {
      errors.push({
        path: label,
        message: 'Non-directory or symbolic-link storage path was skipped.',
      })
      return null
    }

    const resolvedDirectory = await realpath(directory)
    if (!isPathWithin(storageRoot, resolvedDirectory)) {
      errors.push({
        path: label,
        message: 'Storage directory resolves outside the configured root.',
      })
      return null
    }

    return {
      entries: await readdir(resolvedDirectory, { withFileTypes: true }),
      realPath: resolvedDirectory,
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    errors.push({ path: label, message: error.message })
    return null
  }
}

function isPathWithin(root, candidate) {
  const relativePath = path.relative(root, candidate)
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  )
}

function getSafeLocalDatabaseName(databaseUri) {
  if (typeof databaseUri !== 'string' || !databaseUri.startsWith('mongodb://')) {
    throw new Error('Confirmed artifact deletion requires a local MongoDB URI.')
  }

  const authority = databaseUri
    .slice('mongodb://'.length)
    .split(/[/?#]/, 1)[0]
  const hosts = authority.slice(authority.lastIndexOf('@') + 1).split(',')
  const isLoopbackHost = (host) => {
    const normalized = host.trim().toLowerCase()
    const hostname = normalized.startsWith('[')
      ? normalized.slice(0, normalized.indexOf(']') + 1)
      : normalized.replace(/:\d+$/, '')
    return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
  }

  if (!hosts.length || hosts.some((host) => !isLoopbackHost(host))) {
    throw new Error(
      'Confirmed artifact deletion is restricted to loopback MongoDB; remote database deletion is disabled.',
    )
  }

  const databaseName = decodeURIComponent(new URL(databaseUri).pathname.slice(1))
  if (!databaseName || databaseName.includes('/')) {
    throw new Error('Confirmed artifact deletion requires a named safe database.')
  }
  return databaseName
}
