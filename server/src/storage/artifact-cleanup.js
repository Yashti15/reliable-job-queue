import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import JobAsset from '../models/job-asset.model.js'
import { fileStore } from './file-store.js'

const ownerIdPattern = /^[0-9a-f]{24}$/i
const storageKeyPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:pdf|jpg|png|webp)$/

export async function cleanupArtifacts({
  store = fileStore,
  AssetModel = JobAsset,
  retentionMs = 30 * 24 * 60 * 60 * 1000,
  orphanGracePeriodMs = 60 * 60 * 1000,
  dryRun = false,
  ownerId = null,
  now = () => new Date(),
  logger = console,
} = {}) {
  const usersDir = path.resolve(store.root, 'users')
  const currentTime = now() instanceof Date ? now().getTime() : Date.now()

  const summary = {
    scannedFiles: 0,
    orphanFilesDeleted: 0,
    expiredAssetsDeleted: 0,
    bytesReclaimed: 0,
    dryRun: Boolean(dryRun),
    errors: [],
  }

  let ownerEntries
  try {
    ownerEntries = await readdir(usersDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return summary
    }
    throw error
  }

  for (const ownerEntry of ownerEntries) {
    if (!ownerEntry.isDirectory() || !ownerIdPattern.test(ownerEntry.name)) {
      continue
    }

    if (ownerId && ownerEntry.name !== String(ownerId)) {
      continue
    }

    const currentOwnerId = ownerEntry.name

    for (const category of ['uploads', 'outputs']) {
      const categoryDir = path.resolve(usersDir, currentOwnerId, category)
      let fileEntries
      try {
        fileEntries = await readdir(categoryDir, { withFileTypes: true })
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        summary.errors.push({
          ownerId: currentOwnerId,
          category,
          message: error.message,
        })
        continue
      }

      for (const fileEntry of fileEntries) {
        if (!fileEntry.isFile() || !storageKeyPattern.test(fileEntry.name)) {
          continue
        }

        summary.scannedFiles += 1
        const filePath = path.resolve(categoryDir, fileEntry.name)
        let fileStats
        try {
          fileStats = await stat(filePath)
        } catch (error) {
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
          // Orphan file on disk with no database record
          if (fileAge >= orphanGracePeriodMs) {
            if (!dryRun) {
              try {
                await store.remove(currentOwnerId, fileEntry.name, category)
              } catch (error) {
                summary.errors.push({
                  file: fileEntry.name,
                  message: error.message,
                })
                continue
              }
            }
            summary.orphanFilesDeleted += 1
            summary.bytesReclaimed += fileStats.size
            logger?.info?.(
              `Cleaned orphan file: ${category}/${fileEntry.name} (${fileStats.size} bytes)${dryRun ? ' [dry-run]' : ''}`,
            )
          }
        } else {
          // Tracked asset: check retention expiry
          if (fileAge >= retentionMs) {
            if (!dryRun) {
              try {
                await store.remove(currentOwnerId, fileEntry.name, category)
                await AssetModel.deleteOne({ _id: assetRecord._id })
              } catch (error) {
                summary.errors.push({
                  file: fileEntry.name,
                  message: error.message,
                })
                continue
              }
            }
            summary.expiredAssetsDeleted += 1
            summary.bytesReclaimed += fileStats.size
            logger?.info?.(
              `Cleaned expired asset: ${category}/${fileEntry.name} (${fileStats.size} bytes)${dryRun ? ' [dry-run]' : ''}`,
            )
          }
        }
      }
    }
  }

  return summary
}
