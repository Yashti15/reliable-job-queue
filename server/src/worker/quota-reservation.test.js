import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createInMemoryReservationStore,
  reserveAtomicSlot,
  releaseAtomicSlot,
  reservePendingJobSlot,
  reserveStorageSlot,
} from './quota-reservation.js'

test('createInMemoryReservationStore atomically reserves and releases counts', async () => {
  const store = createInMemoryReservationStore()
  const scopeKey = 'test:scope:1'

  // Reserve 2 out of max 5
  const res1 = await reserveAtomicSlot({
    ReservationModel: store,
    scopeKey,
    amount: 2,
    maxAllowed: 5,
  })
  assert.ok(res1)
  assert.equal(store._get(scopeKey).count, 2)

  // Reserve 3 out of max 5 (total 5)
  const res2 = await reserveAtomicSlot({
    ReservationModel: store,
    scopeKey,
    amount: 3,
    maxAllowed: 5,
  })
  assert.ok(res2)
  assert.equal(store._get(scopeKey).count, 5)

  // Try to reserve 1 more when 5/5 used: must fail
  const res3 = await reserveAtomicSlot({
    ReservationModel: store,
    scopeKey,
    amount: 1,
    maxAllowed: 5,
  })
  assert.equal(res3, null)
  assert.equal(store._get(scopeKey).count, 5)

  // Release 2
  await releaseAtomicSlot({
    ReservationModel: store,
    scopeKey,
    amount: 2,
  })
  assert.equal(store._get(scopeKey).count, 3)

  // Now reserve 2 more: must succeed
  const res4 = await reserveAtomicSlot({
    ReservationModel: store,
    scopeKey,
    amount: 2,
    maxAllowed: 5,
  })
  assert.ok(res4)
  assert.equal(store._get(scopeKey).count, 5)
})

test('reserveAtomicSlot auto-heals stale abandoned reservations', async () => {
  const store = createInMemoryReservationStore()
  const scopeKey = 'stale:tenant:1'

  // Manually insert an abandoned reservation older than 60s
  const past = new Date(Date.now() - 120_000)
  await store.updateOne(
    { scopeKey },
    { $set: { count: 5, updatedAt: past } },
    { upsert: true },
  )
  assert.equal(store._get(scopeKey).count, 5)

  // Reserving slot with maxAllowed=5 should heal the stale count and succeed
  const res = await reserveAtomicSlot({
    ReservationModel: store,
    scopeKey,
    amount: 1,
    maxAllowed: 5,
    staleTimeoutMs: 60000,
    now: new Date(),
  })

  assert.ok(res)
  assert.equal(store._get(scopeKey).count, 1)
})

test('reservePendingJobSlot rejects when committed count reaches limit', async () => {
  const store = createInMemoryReservationStore()
  const JobModel = {
    countDocuments: async () => 10,
  }

  const res = await reservePendingJobSlot({
    ownerId: 'owner-1',
    maxPendingJobs: 10,
    JobModel,
    ReservationModel: store,
  })

  assert.equal(res.allowed, false)
  assert.equal(res.code, 'JOB_QUOTA_EXCEEDED')
})

test('reserveStorageSlot checks both uploadCount and byte limits', async () => {
  const store = createInMemoryReservationStore()

  // Case 1: Count limit reached
  const AssetModelCountFull = {
    aggregate: async () => [{ totalBytes: 100, uploadCount: 10 }],
  }
  const res1 = await reserveStorageSlot({
    ownerId: 'owner-2',
    bufferLength: 50,
    maxStorageBytes: 1000,
    maxUploadCount: 10,
    AssetModel: AssetModelCountFull,
    ReservationModel: store,
  })
  assert.equal(res1.allowed, false)
  assert.equal(res1.code, 'STORAGE_QUOTA_EXCEEDED')
  assert.ok(res1.message.includes('Upload limit of 10 images reached'))

  // Case 2: Byte limit reached
  const AssetModelBytesFull = {
    aggregate: async () => [{ totalBytes: 950, uploadCount: 2 }],
  }
  const res2 = await reserveStorageSlot({
    ownerId: 'owner-2',
    bufferLength: 100,
    maxStorageBytes: 1000,
    maxUploadCount: 10,
    AssetModel: AssetModelBytesFull,
    ReservationModel: store,
  })
  assert.equal(res2.allowed, false)
  assert.equal(res2.code, 'STORAGE_QUOTA_EXCEEDED')
  assert.ok(res2.message.includes('Storage quota of 0 MB reached'))
})

test('long-running reservation beyond 60s stale threshold preserves quota and prevents counter corruption on release', async () => {
  const store = createInMemoryReservationStore()
  const ownerId = 'long-running-user'
  const scopeKey = `pending_jobs:${ownerId}`
  const maxPendingJobs = 2

  let committedPendingCount = 0
  const JobModel = {
    countDocuments: async () => committedPendingCount,
  }

  const t0 = new Date('2026-01-01T12:00:00.000Z')
  const t65s = new Date('2026-01-01T12:01:05.000Z')
  const t66s = new Date('2026-01-01T12:01:06.000Z')
  const t67s = new Date('2026-01-01T12:01:07.000Z')
  const t70s = new Date('2026-01-01T12:01:10.000Z')

  // Step 1: Request 1 reserves slot at t0
  const res1 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t0,
  })
  assert.equal(res1.allowed, true)
  assert.equal(store._get(scopeKey).count, 1)

  // Step 2: Request 2 arrives at t65s (>60s stale threshold) while Request 1 is still active
  // Request 2 triggers stale auto-heal on in-flight counter and acquires slot
  const res2 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t65s,
  })
  assert.equal(res2.allowed, true)
  committedPendingCount += 1
  await res2.release()
  assert.equal(store._get(scopeKey).count, 0)

  // Step 3: Request 3 arrives at t66s, commits second job
  const res3 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t66s,
  })
  assert.equal(res3.allowed, true)
  committedPendingCount += 1
  await res3.release()
  assert.equal(store._get(scopeKey).count, 0)
  assert.equal(committedPendingCount, 2, 'Committed quota has reached capacity (2/2)')

  // Step 4: Request 4 arrives at t67s - must be rejected because committed count reached maxPendingJobs
  const res4 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t67s,
  })
  assert.equal(res4.allowed, false)
  assert.equal(res4.code, 'JOB_QUOTA_EXCEEDED')

  // Step 5: Original Request 1 finally finishes at t70s and releases its reservation
  await res1.release()

  // Verify counter is not negative (no corruption/underflow)
  assert.equal(store._get(scopeKey).count, 0)

  // Subsequent request is still blocked because committed jobs remain 2/2
  const res5 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t70s,
  })
  assert.equal(res5.allowed, false)
  assert.equal(res5.code, 'JOB_QUOTA_EXCEEDED')
})

test('concurrent requests against expired reservation execute atomic reset and preserve quota without underflow or over-allocation', async () => {
  const store = createInMemoryReservationStore()
  const ownerId = 'concurrent-stale-user'
  const scopeKey = `pending_jobs:${ownerId}`
  const maxPendingJobs = 2

  const JobModel = {
    countDocuments: async () => 0,
  }

  // Pre-seed an expired reservation with stale count of 5 from 2 hours ago
  const tPast = new Date('2026-01-01T10:00:00.000Z')
  const tNow = new Date('2026-01-01T12:00:00.000Z')
  await store.updateOne(
    { scopeKey },
    { $set: { count: 5, updatedAt: tPast } },
    { upsert: true },
  )
  assert.equal(store._get(scopeKey).count, 5)

  // Launch 8 simultaneous requests at tNow against the expired reservation
  const requests = Array.from({ length: 8 }, async () => {
    await new Promise((r) => setImmediate(r))
    return reservePendingJobSlot({
      ownerId,
      maxPendingJobs,
      JobModel,
      ReservationModel: store,
      now: tNow,
    })
  })

  const responses = await Promise.all(requests)

  const granted = responses.filter((r) => r.allowed === true)
  const denied = responses.filter((r) => r.allowed === false)

  assert.equal(granted.length, 2, 'Exactly 2 slots can be granted from available quota of 2')
  assert.equal(denied.length, 6, 'Remaining 6 requests must be rejected')
  for (const d of denied) {
    assert.equal(d.code, 'JOB_QUOTA_EXCEEDED')
  }

  // Verify exact counter in store is 2 (no over-allocation)
  assert.equal(store._get(scopeKey).count, 2)

  // Release all granted reservations
  await Promise.all(granted.map((g) => g.release()))

  // Verify counter returned to exactly 0 (no underflow)
  assert.equal(store._get(scopeKey).count, 0)
})

test('token isolation ensures releasing an old stale reservation cannot decrement a newer active reservation', async () => {
  const store = createInMemoryReservationStore()
  const ownerId = 'token-isolation-user'
  const scopeKey = `pending_jobs:${ownerId}`
  const maxPendingJobs = 2

  let committedPendingCount = 0
  const JobModel = {
    countDocuments: async () => committedPendingCount,
  }

  const t0 = new Date('2026-01-01T12:00:00.000Z')
  const t65s = new Date('2026-01-01T12:01:05.000Z')
  const t70s = new Date('2026-01-01T12:01:10.000Z')

  // 1. Request 1 reserves a slot and remains active.
  const res1 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t0,
  })
  assert.equal(res1.allowed, true)
  assert.equal(store._get(scopeKey).count, 1)

  // 2. Advance the controlled clock beyond the 60-second stale threshold.
  // 3. Trigger stale healing.
  // 4. Request 2 reserves a new slot and remains active.
  const res2 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t65s,
  })
  assert.equal(res2.allowed, true)
  assert.equal(store._get(scopeKey).count, 1)

  // 5. Release Request 1 while Request 2 is still active.
  await res1.release()

  // 6. Verify the counter still reflects Request 2's active reservation.
  assert.equal(
    store._get(scopeKey).count,
    1,
    "Counter must still reflect Request 2's active reservation and not be decremented by Request 1",
  )

  // 7. Verify another request cannot exceed the configured quota.
  // Committed = 1 (simulated job created), in-flight = 1, limit = 2 -> 1 slot available, count = 1 -> must reject
  committedPendingCount = 1
  const res3 = await reservePendingJobSlot({
    ownerId,
    maxPendingJobs,
    JobModel,
    ReservationModel: store,
    now: t70s,
  })
  assert.equal(res3.allowed, false)
  assert.equal(res3.code, 'JOB_QUOTA_EXCEEDED')

  // 8. Release Request 2 and verify the counter returns to zero.
  await res2.release()
  assert.equal(
    store._get(scopeKey).count,
    0,
    'Counter must return to zero after Request 2 is released',
  )
})
