import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import mongoose from 'mongoose'
import { createFileStore } from './file-store.js'
import { cleanupArtifacts } from './artifact-cleanup.js'

function createMockAssetModel() {
  const records = []
  const model = {
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
    find(query) {
      return {
        async lean() {
          return records.filter(
            (record) =>
              query.$or.some(
                (condition) =>
                  (condition.cleanupPending === true &&
                    record.cleanupPending === true) ||
                  (condition.createdAt?.$lte instanceof Date &&
                    record.createdAt instanceof Date &&
                    record.createdAt <= condition.createdAt.$lte),
              ) &&
              (!query.ownerId ||
                String(record.ownerId) === String(query.ownerId)),
          )
        },
      }
    },
    async updateOne(query, update) {
      model.updateCalls += 1
      if (model.failNextUpdate) {
        model.failNextUpdate = false
        throw new Error('Injected metadata update failure.')
      }
      const record = records.find(
        (candidate) =>
          String(candidate._id) === String(query._id) &&
          String(candidate.ownerId) === String(query.ownerId) &&
          candidate.storageKey === query.storageKey,
      )
      if (record) Object.assign(record, update.$set)
      return { matchedCount: record ? 1 : 0 }
    },
    async deleteOne(query) {
      model.deleteCalls += 1
      if (model.failNextDelete) {
        model.failNextDelete = false
        throw new Error('Injected metadata deletion failure.')
      }
      const index = records.findIndex(
        (record) =>
          String(record._id) === String(query._id) &&
          String(record.ownerId) === String(query.ownerId) &&
        record.storageKey === query.storageKey &&
        (!query.cleanupPending || record.cleanupPending === true),
      )
      if (index !== -1) records.splice(index, 1)
      return { deletedCount: index !== -1 ? 1 : 0 }
    },
  }
  model.updateCalls = 0
  model.deleteCalls = 0
  model.failNextUpdate = false
  model.failNextDelete = false
  return model
}

const safeDeletionTarget = {
  targetEnvironment: 'test',
  databaseUri: 'mongodb://127.0.0.1:27017/reliable_job_queue_test',
  targetIdentity: 'reliable_job_queue_test',
}

test('cleanupArtifacts returns cleanly when storage users directory is empty', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-empty-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })

  const summary = await cleanupArtifacts({
    store,
    AssetModel: createMockAssetModel(),
  })
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
    ...safeDeletionTarget,
    confirm: true,
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
    ...safeDeletionTarget,
    confirm: true,
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
    now: () => oneYearLater,
    logger: { info() {} },
  })

  assert.equal(summary.dryRun, true)
  assert.equal(summary.candidates.length, 1)
  assert.equal(summary.expiredAssetsDeleted, 1)
  assert.equal(AssetModel.records.length, 1) // record preserved
  assert.equal(AssetModel.updateCalls, 0)
  assert.equal(AssetModel.deleteCalls, 0)

  // Disk file preserved
  const loaded = await store.load(ownerId, file.storageKey, 'outputs')
  assert.equal(loaded.toString(), '%PDF-dryrun')
})

test('cleanupArtifacts blocks deletion unless explicitly confirmed', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-confirm-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-confirm'))
  const AssetModel = createMockAssetModel()

  await assert.rejects(
    cleanupArtifacts({ store, AssetModel, dryRun: false }),
    /explicit confirmation/,
  )

  assert.equal(AssetModel.records.length, 0)
  assert.equal((await store.load(ownerId, file.storageKey, 'outputs')).toString(), '%PDF-confirm')
})

test('cleanup service independently blocks production deletion', async () => {
  await assert.rejects(
    cleanupArtifacts({
      confirm: true,
      targetEnvironment: 'production',
      databaseUri: 'mongodb://127.0.0.1:27017/reliable_job_queue_dev',
      targetIdentity: 'reliable_job_queue_dev',
      AssetModel: createMockAssetModel(),
      logger: { info() {} },
    }),
    /disabled in production/,
  )
})

test('cleanup service requires an explicit matching local target identity', async () => {
  await assert.rejects(
    cleanupArtifacts({
      confirm: true,
      targetEnvironment: 'development',
      databaseUri: 'mongodb://127.0.0.1:27017/reliable_job_queue_dev',
      AssetModel: createMockAssetModel(),
      logger: { info() {} },
    }),
    /exactly match/,
  )
})

test('cleanupArtifacts safely removes metadata when an expired asset file is already missing', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-missing-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-missing'))
  const AssetModel = createMockAssetModel()
  AssetModel.records.push({
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    storageKey: file.storageKey,
    kind: 'output',
    createdAt: new Date(0),
  })
  await store.remove(ownerId, file.storageKey, 'outputs')

  const summary = await cleanupArtifacts({
    store,
    AssetModel,
    ...safeDeletionTarget,
    retentionMs: 1,
    orphanGracePeriodMs: 1,
    confirm: true,
    dryRun: false,
    now: () => new Date(),
  })

  assert.equal(summary.expiredAssetsDeleted, 1)
  assert.equal(summary.bytesReclaimed, 0)
  assert.equal(summary.errors.length, 0)
  assert.equal(AssetModel.records.length, 0)
})

test('cleanupArtifacts leaves file and metadata intact when marking cleanup pending fails', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-mark-failure-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-mark-failure'))
  const AssetModel = createMockAssetModel()
  AssetModel.records.push({
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    storageKey: file.storageKey,
    kind: 'output',
    createdAt: new Date(0),
  })
  AssetModel.failNextUpdate = true

  const summary = await cleanupArtifacts({
    store,
    AssetModel,
    ...safeDeletionTarget,
    retentionMs: 1,
    confirm: true,
    dryRun: false,
    now: () => new Date(Date.now() + 2),
  })

  assert.equal(summary.errors.length, 1)
  assert.equal(AssetModel.records.length, 1)
  assert.equal(AssetModel.records[0].cleanupPending, undefined)
  assert.equal((await store.load(ownerId, file.storageKey, 'outputs')).toString(), '%PDF-mark-failure')
})

test('cleanupArtifacts can retry metadata deletion after the file was removed', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-db-failure-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-db-failure'))
  const AssetModel = createMockAssetModel()
  AssetModel.records.push({
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    storageKey: file.storageKey,
    kind: 'output',
  })
  AssetModel.failNextDelete = true
  const now = () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000)
  const options = {
    store,
    AssetModel,
    ...safeDeletionTarget,
    retentionMs: 24 * 60 * 60 * 1000,
    confirm: true,
    dryRun: false,
    now,
  }

  const failed = await cleanupArtifacts(options)
  assert.equal(failed.errors.length, 1)
  assert.equal(AssetModel.records.length, 1)
  assert.equal(AssetModel.records[0].cleanupPending, true)
  await assert.rejects(store.load(ownerId, file.storageKey, 'outputs'))

  const retried = await cleanupArtifacts(options)
  assert.equal(retried.errors.length, 0)
  assert.equal(retried.expiredAssetsDeleted, 1)
  assert.equal(AssetModel.records.length, 0)
  await assert.rejects(store.load(ownerId, file.storageKey, 'outputs'))
})

test('cleanupArtifacts can retry tracked-file removal after metadata was deleted', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-file-failure-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const baseStore = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await baseStore.save(ownerId, 'uploads', 'png', Buffer.from('orphan-file'))
  const AssetModel = createMockAssetModel()
  AssetModel.records.push({
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    storageKey: file.storageKey,
    kind: 'upload',
  })
  let failNextRemove = true
  const store = {
    get root() {
      return baseStore.root
    },
    stat: (...args) => baseStore.stat(...args),
    remove: async (...args) => {
      if (failNextRemove) {
        failNextRemove = false
        throw new Error('Injected filesystem deletion failure.')
      }
      return baseStore.remove(...args)
    },
  }
  const options = {
    store,
    AssetModel,
    ...safeDeletionTarget,
    retentionMs: 1,
    orphanGracePeriodMs: 30 * 24 * 60 * 60 * 1000,
    confirm: true,
    dryRun: false,
    now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  }

  const failed = await cleanupArtifacts(options)
  assert.equal(failed.errors.length, 1)
  assert.equal(failed.expiredAssetsDeleted, 0)
  assert.equal(AssetModel.records.length, 1)
  assert.equal(AssetModel.records[0].cleanupPending, true)
  assert.equal((await baseStore.load(ownerId, file.storageKey, 'uploads')).toString(), 'orphan-file')

  const retried = await cleanupArtifacts(options)
  assert.equal(retried.errors.length, 0)
  assert.equal(retried.expiredAssetsDeleted, 1)
  assert.equal(AssetModel.records.length, 0)
  await assert.rejects(baseStore.load(ownerId, file.storageKey, 'uploads'))
})

test('cleanupArtifacts is idempotent when cleanup is repeated', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-repeat-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('%PDF-repeat'))
  const AssetModel = createMockAssetModel()
  AssetModel.records.push({
    _id: new mongoose.Types.ObjectId(),
    ownerId,
    storageKey: file.storageKey,
    kind: 'output',
  })
  const options = {
    store,
    AssetModel,
    ...safeDeletionTarget,
    retentionMs: 1,
    orphanGracePeriodMs: 1,
    confirm: true,
    dryRun: false,
    now: () => new Date(Date.now() + 2),
  }

  const first = await cleanupArtifacts(options)
  const second = await cleanupArtifacts(options)

  assert.equal(first.expiredAssetsDeleted, 1)
  assert.equal(second.candidates.length, 0)
  assert.equal(second.expiredAssetsDeleted, 0)
  assert.equal(second.orphanFilesDeleted, 0)
  assert.equal(AssetModel.records.length, 0)
})

test('cleanupArtifacts skips symlinked owner directories', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-owner-link-'))
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-owner-target-'))
  context.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  const outsideStore = createFileStore({ root: outsideRoot })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await outsideStore.save(
    ownerId,
    'uploads',
    'png',
    Buffer.from('outside-owner'),
  )
  const usersDirectory = path.join(root, 'users')
  await mkdir(usersDirectory, { recursive: true })
  const ownerLink = path.join(usersDirectory, ownerId)
  if (
    !(await createSymlinkOrSkip(
      context,
      path.join(outsideRoot, 'users', ownerId),
      ownerLink,
      'junction',
    ))
  ) {
    return
  }

  const summary = await cleanupArtifacts({
    store: createFileStore({ root }),
    AssetModel: createMockAssetModel(),
    ...safeDeletionTarget,
    confirm: true,
    dryRun: false,
    orphanGracePeriodMs: 1,
    now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    logger: { info() {} },
  })

  assert.equal(summary.orphanFilesDeleted, 0)
  assert.ok(summary.errors.some((error) => error.message.includes('Symbolic-link')))
  assert.equal(
    (await outsideStore.load(ownerId, file.storageKey, 'uploads')).toString(),
    'outside-owner',
  )
})

test('cleanupArtifacts refuses a symlinked storage root', async (context) => {
  const parentRoot = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-root-link-'))
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-root-target-'))
  context.after(async () => {
    await rm(parentRoot, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })
  if (
    !(await createSymlinkOrSkip(
      context,
      outsideRoot,
      path.join(parentRoot, 'linked-storage'),
      'junction',
    ))
  ) {
    return
  }

  await assert.rejects(
    cleanupArtifacts({
      store: createFileStore({ root: path.join(parentRoot, 'linked-storage') }),
      AssetModel: createMockAssetModel(),
    }),
    /storage root cannot be a symbolic link/,
  )
})

test('cleanupArtifacts skips symlinked category directories', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-category-link-'))
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-category-target-'))
  context.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  const outsideStore = createFileStore({ root: outsideRoot })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await outsideStore.save(
    ownerId,
    'uploads',
    'png',
    Buffer.from('outside-category'),
  )
  const categoryDirectory = path.join(root, 'users', ownerId, 'uploads')
  await mkdir(path.dirname(categoryDirectory), { recursive: true })
  if (
    !(await createSymlinkOrSkip(
      context,
      path.join(outsideRoot, 'users', ownerId, 'uploads'),
      categoryDirectory,
      'junction',
    ))
  ) {
    return
  }

  const summary = await cleanupArtifacts({
    store: createFileStore({ root }),
    AssetModel: createMockAssetModel(),
    ...safeDeletionTarget,
    confirm: true,
    dryRun: false,
    orphanGracePeriodMs: 1,
    now: () => new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    logger: { info() {} },
  })

  assert.equal(summary.orphanFilesDeleted, 0)
  assert.ok(summary.errors.some((error) => error.message.includes('symbolic-link')))
  assert.equal(
    (await outsideStore.load(ownerId, file.storageKey, 'uploads')).toString(),
    'outside-category',
  )
})

test('fileStore refuses to remove symlinked artifact files', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-file-link-'))
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), 'rq-cleanup-file-target-'))
  context.after(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outsideRoot, { recursive: true, force: true })
  })

  const outsideStore = createFileStore({ root: outsideRoot })
  const ownerId = new mongoose.Types.ObjectId().toString()
  const file = await outsideStore.save(
    ownerId,
    'uploads',
    'png',
    Buffer.from('outside-file'),
  )
  const linkedFile = path.join(root, 'users', ownerId, 'uploads', file.storageKey)
  await mkdir(path.dirname(linkedFile), { recursive: true })
  if (
    !(await createSymlinkOrSkip(
      context,
      path.join(
        outsideRoot,
        'users',
        ownerId,
        'uploads',
        file.storageKey,
      ),
      linkedFile,
      'file',
    ))
  ) {
    return
  }

  const store = createFileStore({ root })
  await assert.rejects(
    store.remove(ownerId, file.storageKey, 'uploads'),
    /symbolic link/,
  )
  await assert.rejects(
    store.load(ownerId, file.storageKey, 'uploads'),
    /symbolic link/,
  )
  assert.equal(
    (await outsideStore.load(ownerId, file.storageKey, 'uploads')).toString(),
    'outside-file',
  )
})

async function createSymlinkOrSkip(context, target, linkPath, type) {
  try {
    await symlink(target, linkPath, type)
    return true
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
      context.skip(`This environment does not permit symlink creation (${error.code}).`)
      return false
    }
    throw error
  }
}
