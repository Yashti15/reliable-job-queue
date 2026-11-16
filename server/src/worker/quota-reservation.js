import crypto from 'node:crypto'
import mongoose from 'mongoose'
import QuotaReservation from '../models/quota-reservation.model.js'

export function createInMemoryReservationStore() {
  const store = new Map()

  return {
    async findOne(filter) {
      const scopeKey = filter.scopeKey
      const doc = store.get(scopeKey)
      if (!doc) return null

      if (filter['reservations.expiresAt']?.$lte) {
        const threshold = filter['reservations.expiresAt'].$lte
        const hasExpired = doc.reservations?.some((r) => r.expiresAt <= threshold)
        if (!hasExpired) return null
      }

      return {
        ...doc,
        reservations: doc.reservations ? doc.reservations.map((r) => ({ ...r })) : [],
      }
    },

    async updateOne(filter, update, options = {}) {
      const scopeKey = filter.scopeKey
      let doc = store.get(scopeKey)

      if (!doc && options.upsert) {
        doc = { scopeKey, count: 0, reservations: [], updatedAt: new Date() }
        store.set(scopeKey, doc)
      }

      if (!doc) return { matchedCount: 0, modifiedCount: 0 }

      if (filter['reservations.token']) {
        const targetToken = filter['reservations.token']
        if (typeof targetToken === 'object' && targetToken.$in) {
          const hasAny = doc.reservations?.some((r) => targetToken.$in.includes(r.token))
          if (!hasAny) return { matchedCount: 0, modifiedCount: 0 }
        } else {
          const hasToken = doc.reservations?.some((r) => r.token === targetToken)
          if (!hasToken) return { matchedCount: 0, modifiedCount: 0 }
        }
      }

      if (filter.updatedAt?.$lt && !(doc.updatedAt < filter.updatedAt.$lt)) {
        return { matchedCount: 0, modifiedCount: 0 }
      }

      if (filter.$or) {
        const matchesOr = filter.$or.some((clause) => {
          if (clause.reservations?.$exists === false) return !doc.reservations
          if (clause.reservations?.$size === 0) return (doc.reservations || []).length === 0
          return false
        })
        if (!matchesOr) return { matchedCount: 0, modifiedCount: 0 }
      }

      if (filter.count !== undefined) {
        if (typeof filter.count === 'object') {
          if (filter.count.$gte !== undefined && !(doc.count >= filter.count.$gte)) {
            return { matchedCount: 0, modifiedCount: 0 }
          }
          if (filter.count.$gt !== undefined && !(doc.count > filter.count.$gt)) {
            return { matchedCount: 0, modifiedCount: 0 }
          }
        } else if (doc.count !== filter.count) {
          return { matchedCount: 0, modifiedCount: 0 }
        }
      }

      if (update.$pull?.reservations) {
        const pullCond = update.$pull.reservations
        if (pullCond.token) {
          if (typeof pullCond.token === 'object' && pullCond.token.$in) {
            doc.reservations = (doc.reservations || []).filter(
              (r) => !pullCond.token.$in.includes(r.token),
            )
          } else {
            doc.reservations = (doc.reservations || []).filter((r) => r.token !== pullCond.token)
          }
        }
      }

      if (update.$push?.reservations) {
        doc.reservations = doc.reservations || []
        doc.reservations.push({ ...update.$push.reservations })
      }

      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = Math.max(0, (doc[k] || 0) + v)
        }
      }
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          doc[k] = v
        }
      }
      return { matchedCount: 1, modifiedCount: 1 }
    },

    async findOneAndUpdate(filter, update, options = {}) {
      const scopeKey = filter.scopeKey
      let doc = store.get(scopeKey)

      if (!doc && options.upsert) {
        doc = { scopeKey, count: 0, reservations: [], updatedAt: new Date() }
        store.set(scopeKey, doc)
      }
      if (!doc) return null

      if (filter.count !== undefined) {
        if (typeof filter.count === 'object') {
          if (filter.count.$lte !== undefined && !(doc.count <= filter.count.$lte)) {
            return null
          }
          if (filter.count.$lt !== undefined && !(doc.count < filter.count.$lt)) {
            return null
          }
        } else if (doc.count !== filter.count) {
          return null
        }
      }

      if (update.$push?.reservations) {
        doc.reservations = doc.reservations || []
        doc.reservations.push({ ...update.$push.reservations })
      }

      if (update.$inc) {
        for (const [k, v] of Object.entries(update.$inc)) {
          doc[k] = Math.max(0, (doc[k] || 0) + v)
        }
      }
      if (update.$set) {
        for (const [k, v] of Object.entries(update.$set)) {
          doc[k] = v
        }
      }
      return {
        ...doc,
        reservations: doc.reservations ? doc.reservations.map((r) => ({ ...r })) : [],
      }
    },

    _get(scopeKey) {
      return store.get(scopeKey)
    },
    _clear() {
      store.clear()
    },
  }
}

const defaultInMemoryStore = createInMemoryReservationStore()

function getActiveReservationModel(ReservationModel) {
  if (ReservationModel && typeof ReservationModel.findOneAndUpdate === 'function') {
    if (ReservationModel === QuotaReservation && mongoose.connection.readyState !== 1) {
      return defaultInMemoryStore
    }
    return ReservationModel
  }
  return defaultInMemoryStore
}

export async function reserveAtomicSlot({
  ReservationModel = QuotaReservation,
  scopeKey,
  amount = 1,
  maxAllowed,
  staleTimeoutMs = 60000,
  now = new Date(),
}) {
  if (amount <= 0 || maxAllowed < amount) {
    return null
  }

  const Model = getActiveReservationModel(ReservationModel)
  const maxCurrentCount = maxAllowed - amount

  // 1. Clean up expired reservation tokens token-by-token
  try {
    const doc = await Model.findOne({
      scopeKey,
      'reservations.expiresAt': { $lte: now },
    })
    const docData = doc?.lean ? await doc.lean() : doc
    if (docData?.reservations?.length > 0) {
      const expired = docData.reservations.filter((r) => r.expiresAt <= now)
      for (const exp of expired) {
        await Model.updateOne(
          { scopeKey, 'reservations.token': exp.token },
          {
            $pull: { reservations: { token: exp.token } },
            $inc: { count: -exp.amount },
            $set: { updatedAt: now },
          },
        )
      }
    }
  } catch {
    // Ignore stale cleanup errors
  }

  // 2. Clean up legacy un-tokened stale reservations if any
  try {
    const staleThreshold = new Date(now.getTime() - staleTimeoutMs)
    await Model.updateOne(
      {
        scopeKey,
        updatedAt: { $lt: staleThreshold },
        count: { $gt: 0 },
        $or: [{ reservations: { $exists: false } }, { reservations: { $size: 0 } }],
      },
      { $set: { count: 0, updatedAt: now } },
    )
  } catch {
    // Ignore legacy stale cleanup errors
  }

  // 3. Ensure record exists
  try {
    await Model.updateOne(
      { scopeKey },
      { $setOnInsert: { scopeKey, count: 0, reservations: [] } },
      { upsert: true },
    )
  } catch (error) {
    if (error?.code !== 11000) throw error
  }

  const token = crypto.randomUUID()
  const expiresAt = new Date(now.getTime() + staleTimeoutMs)

  const updated = await Model.findOneAndUpdate(
    { scopeKey, count: { $lte: maxCurrentCount } },
    {
      $inc: { count: amount },
      $push: { reservations: { token, amount, expiresAt } },
      $set: { updatedAt: now },
    },
    { new: true },
  )

  return updated ? { scopeKey, amount, token } : null
}

export async function releaseAtomicSlot({
  ReservationModel = QuotaReservation,
  scopeKey,
  amount = 1,
  token,
}) {
  if (!scopeKey || amount <= 0) return
  const Model = getActiveReservationModel(ReservationModel)
  try {
    if (token) {
      await Model.updateOne(
        { scopeKey, 'reservations.token': token },
        {
          $pull: { reservations: { token } },
          $inc: { count: -amount },
          $set: { updatedAt: new Date() },
        },
      )
    } else {
      await Model.updateOne(
        { scopeKey, count: { $gte: amount } },
        { $inc: { count: -amount }, $set: { updatedAt: new Date() } },
      )
    }
  } catch (error) {
    console.error(
      `Quota reservation release failed for ${scopeKey} (${error?.name ?? 'UnknownError'}).`,
    )
  }
}

export async function getOwnerStorageUsage(AssetModel, ownerId) {
  if (typeof AssetModel?.aggregate === 'function') {
    const ownerObjectId =
      typeof ownerId === 'string' && mongoose.isObjectIdOrHexString(ownerId)
        ? new mongoose.Types.ObjectId(ownerId)
        : ownerId
    const [summary = { totalBytes: 0, uploadCount: 0 }] =
      await AssetModel.aggregate([
        { $match: { ownerId: ownerObjectId } },
        {
          $group: {
            _id: null,
            totalBytes: { $sum: '$sizeBytes' },
            uploadCount: {
              $sum: { $cond: [{ $eq: ['$kind', 'upload'] }, 1, 0] },
            },
          },
        },
      ])
    return {
      totalBytes: summary.totalBytes ?? 0,
      uploadCount: summary.uploadCount ?? 0,
    }
  }

  if (typeof AssetModel?.find === 'function') {
    const query = AssetModel.find({ ownerId })
    const records = query.lean ? await query.lean() : await query
    if (Array.isArray(records)) {
      return records.reduce(
        (acc, record) => ({
          totalBytes: acc.totalBytes + (record.sizeBytes || 0),
          uploadCount: acc.uploadCount + (record.kind === 'upload' ? 1 : 0),
        }),
        { totalBytes: 0, uploadCount: 0 },
      )
    }
  }

  return { totalBytes: 0, uploadCount: 0 }
}

export async function reservePendingJobSlot({
  ownerId,
  maxPendingJobs = 50,
  JobModel,
  ReservationModel = QuotaReservation,
  now = new Date(),
}) {
  let committedCount = 0
  if (typeof JobModel?.countDocuments === 'function') {
    committedCount = await JobModel.countDocuments({
      ownerId,
      status: 'pending',
    })
  }

  const availableSlots = maxPendingJobs - committedCount
  if (availableSlots <= 0) {
    return {
      allowed: false,
      code: 'JOB_QUOTA_EXCEEDED',
      message: `Pending job limit of ${maxPendingJobs} reached for this account. Wait for pending jobs to complete before submitting more.`,
    }
  }

  const scopeKey = `pending_jobs:${String(ownerId)}`
  const Model = getActiveReservationModel(ReservationModel)
  const reserved = await reserveAtomicSlot({
    ReservationModel: Model,
    scopeKey,
    amount: 1,
    maxAllowed: availableSlots,
    now,
  })

  if (!reserved) {
    return {
      allowed: false,
      code: 'JOB_QUOTA_EXCEEDED',
      message: `Pending job limit of ${maxPendingJobs} reached for this account. Wait for pending jobs to complete before submitting more.`,
    }
  }

  if (typeof JobModel?.countDocuments === 'function') {
    const committedNow = await JobModel.countDocuments({
      ownerId,
      status: 'pending',
    })
    const doc = await Model.findOne({ scopeKey })
    const inFlight = doc?.count ?? 1
    if (committedNow + inFlight > maxPendingJobs) {
      await releaseAtomicSlot({
        ReservationModel: Model,
        scopeKey,
        amount: 1,
        token: reserved.token,
      })
      return {
        allowed: false,
        code: 'JOB_QUOTA_EXCEEDED',
        message: `Pending job limit of ${maxPendingJobs} reached for this account. Wait for pending jobs to complete before submitting more.`,
      }
    }
  }

  let released = false
  return {
    allowed: true,
    token: reserved.token,
    async release() {
      if (released) return
      released = true
      await releaseAtomicSlot({
        ReservationModel: Model,
        scopeKey,
        amount: 1,
        token: reserved.token,
      })
    },
  }
}

export async function reserveStorageSlot({
  ownerId,
  bufferLength,
  maxStorageBytes,
  maxUploadCount,
  AssetModel,
  ReservationModel = QuotaReservation,
  now = new Date(),
}) {
  const usage = await getOwnerStorageUsage(AssetModel, ownerId)
  const availableUploads = maxUploadCount - usage.uploadCount
  if (availableUploads < 1) {
    return {
      allowed: false,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: `Upload limit of ${maxUploadCount} images reached for this account. Delete older jobs or wait for cleanup before uploading more images.`,
    }
  }

  const availableBytes = maxStorageBytes - usage.totalBytes
  if (availableBytes < bufferLength) {
    const quotaMb = Math.round(maxStorageBytes / (1024 * 1024))
    return {
      allowed: false,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: `Storage quota of ${quotaMb} MB reached for this account. Wait for artifact cleanup before uploading more files.`,
    }
  }

  const countScopeKey = `storage_count:${String(ownerId)}`
  const bytesScopeKey = `storage_bytes:${String(ownerId)}`

  const Model = getActiveReservationModel(ReservationModel)
  const reservedCount = await reserveAtomicSlot({
    ReservationModel: Model,
    scopeKey: countScopeKey,
    amount: 1,
    maxAllowed: availableUploads,
    now,
  })

  if (!reservedCount) {
    return {
      allowed: false,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: `Upload limit of ${maxUploadCount} images reached for this account. Delete older jobs or wait for cleanup before uploading more images.`,
    }
  }

  const reservedBytes = await reserveAtomicSlot({
    ReservationModel: Model,
    scopeKey: bytesScopeKey,
    amount: bufferLength,
    maxAllowed: availableBytes,
    now,
  })

  if (!reservedBytes) {
    await releaseAtomicSlot({
      ReservationModel: Model,
      scopeKey: countScopeKey,
      amount: 1,
      token: reservedCount.token,
    })
    const quotaMb = Math.round(maxStorageBytes / (1024 * 1024))
    return {
      allowed: false,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message: `Storage quota of ${quotaMb} MB reached for this account. Wait for artifact cleanup before uploading more files.`,
    }
  }

  const usageNow = await getOwnerStorageUsage(AssetModel, ownerId)
  const countDoc = await Model.findOne({ scopeKey: countScopeKey })
  const bytesDoc = await Model.findOne({ scopeKey: bytesScopeKey })
  const inFlightCount = countDoc?.count ?? 1
  const inFlightBytes = bytesDoc?.count ?? bufferLength

  if (
    usageNow.uploadCount + inFlightCount > maxUploadCount ||
    usageNow.totalBytes + inFlightBytes > maxStorageBytes
  ) {
    await releaseAtomicSlot({
      ReservationModel: Model,
      scopeKey: countScopeKey,
      amount: 1,
      token: reservedCount.token,
    })
    await releaseAtomicSlot({
      ReservationModel: Model,
      scopeKey: bytesScopeKey,
      amount: bufferLength,
      token: reservedBytes.token,
    })
    const quotaMb = Math.round(maxStorageBytes / (1024 * 1024))
    return {
      allowed: false,
      code: 'STORAGE_QUOTA_EXCEEDED',
      message:
        usageNow.uploadCount + inFlightCount > maxUploadCount
          ? `Upload limit of ${maxUploadCount} images reached for this account. Delete older jobs or wait for cleanup before uploading more images.`
          : `Storage quota of ${quotaMb} MB reached for this account. Wait for artifact cleanup before uploading more files.`,
    }
  }

  let released = false
  return {
    allowed: true,
    tokens: {
      countToken: reservedCount.token,
      bytesToken: reservedBytes.token,
    },
    async release() {
      if (released) return
      released = true
      await releaseAtomicSlot({
        ReservationModel: Model,
        scopeKey: bytesScopeKey,
        amount: bufferLength,
        token: reservedBytes.token,
      })
      await releaseAtomicSlot({
        ReservationModel: Model,
        scopeKey: countScopeKey,
        amount: 1,
        token: reservedCount.token,
      })
    },
  }
}
