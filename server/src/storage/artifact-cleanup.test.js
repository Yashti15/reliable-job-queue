import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import mongoose from 'mongoose'
import { createFileStore } from './file-store.js'
import { cleanupArtifacts } from './artifact-cleanup.js'

function createMockAssetModel() {
  const records = []
  return {
    records,
    findOne(query) {
      return {
        async lean() {
          return (
            records.find(
              (record) =>
                String(record.ownerId) === String(query.ownerId) &&
                record.storageKey === query.storageKey,
            ) ?? null
          )
        },
      }
    },
    async deleteOne(query) {
      const index = records.findIndex(
        (record) => String(record._id) === String(query._id),
      )
      if (index !== -1) records.splice(index, 1)
      return { deletedCount: index !== -1 ? 1 : 0 }
    },
  }
}

test('cleanupArtifacts returns cleanly when storage users directory is empty', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-empty-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })

  const summary = await cleanupArtifacts({ store })
  assert.equal(summary.scannedFiles, 0)
  assert.equal(summary.orphanFilesDeleted, 0)
  assert.equal(summary.expiredAssetsDeleted, 0)
})

test('cleanupArtifacts removes orphan files older than grace period and preserves young files', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-orphan-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()

  // Save two files
  const oldFile = await store.save(ownerId, 'uploads', 'png', Buffer.from('old-orphan-data'))
  const freshFile = await store.save(ownerId, 'uploads', 'png', Buffer.from('fresh-orphan-data'))

  const AssetModel = createMockAssetModel()
  // Neither file has a JobAsset record (they are orphans)

  // Simulation time: 2 hours after creation
  const twoHoursLater = new Date(Date.now() + 2 * 60 * 60 * 1000)

  // Run cleanup with 1 hour grace period
  const summary = await cleanupArtifacts({
    store,
    AssetModel,
    orphanGracePeriodMs: 60 * 60 * 1000,
    now: () => twoHoursLater,
  })

  assert.equal(summary.scannedFiles, 2)
  assert.equal(summary.orphanFilesDeleted, 2)
  assert.equal(summary.bytesReclaimed, 'old-orphan-data'.length + 'fresh-orphan-data'.length)

  // Files should be deleted from disk
  await assert.rejects(store.load(ownerId, oldFile.storageKey, 'uploads'))
  await assert.rejects(store.load(ownerId, freshFile.storageKey, 'uploads'))
})

test('cleanupArtifacts preserves young orphan files within the grace period', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-young-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()

  const freshFile = await store.save(ownerId, 'uploads', 'png', Buffer.from('fresh-in-flight'))
  const AssetModel = createMockAssetModel()

  // Cleanup with 1 hour grace period, but now is only 5 minutes later
  const fiveMinutesLater = new Date(Date.now() + 5 * 60 * 1000)
  const summary = await cleanupArtifacts({
    store,
    AssetModel,
    orphanGracePeriodMs: 60 * 60 * 1000,
    now: () => fiveMinutesLater,
  })

  assert.equal(summary.scannedFiles, 1)
  assert.equal(summary.orphanFilesDeleted, 0)

  // File must still be intact on disk
  const content = await store.load(ownerId, freshFile.storageKey, 'uploads')
  assert.equal(content.toString(), 'fresh-in-flight')
})

test('cleanupArtifacts deletes expired tracked assets and keeps active ones', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-retention-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const AssetModel = createMockAssetModel()

  const fileA = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-1.4 file A'))
  const assetIdA = new mongoose.Types.ObjectId()
  AssetModel.records.push({
    _id: assetIdA,
    ownerId,
    storageKey: fileA.storageKey,
    kind: 'output',
  })

  // Cleanup with retention of 10 days, simulated time 15 days later
  const fifteenDaysLater = new Date(Date.now() + 15 * 24 * 60 * 60 * 1000)
  const summary = await cleanupArtifacts({
    store,
    AssetModel,
    retentionMs: 10 * 24 * 60 * 60 * 1000,
    now: () => fifteenDaysLater,
  })

  assert.equal(summary.scannedFiles, 1)
  assert.equal(summary.expiredAssetsDeleted, 1)
  assert.equal(AssetModel.records.length, 0)

  // Disk file deleted
  await assert.rejects(store.load(ownerId, fileA.storageKey, 'outputs'))
})

test('cleanupArtifacts dryRun mode reports deletions without removing files or records', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-dryrun-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const AssetModel = createMockAssetModel()

  const file = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-dryrun'))
  AssetModel.records.push({
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    storageKey: file.storageKey,
    kind: 'output',
  })

  const oneYearLater = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
  const summary = await cleanupArtifacts({
    store,
    AssetModel,
    retentionMs: 30 * 24 * 60 * 60 * 1000,
    dryRun: true,
    now: () => oneYearLater,
  })

  assert.equal(summary.dryRun, true)
  assert.equal(summary.expiredAssetsDeleted, 1)
  assert.equal(AssetModel.records.length, 1) // record preserved

  // Disk file preserved
  const loaded = await store.load(ownerId, file.storageKey, 'outputs')
  assert.equal(loaded.toString(), '%PDF-dryrun')
})
