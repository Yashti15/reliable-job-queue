import assert from 'node:assert/strict'
import { test } from 'node:test'
import mongoose from 'mongoose'
import { createJobsRouter } from './jobs.routes.js'
import { createUploadsRouter } from './uploads.routes.js'
import { createInMemoryReservationStore } from '../worker/quota-reservation.js'

function invokeRouter(router, { method = 'GET', url = '/', body = {}, authUser = {}, headers = {} } = {}) {
  return new Promise((resolve) => {
    let statusCode = 200
    let responseHeaders = {}
    let responseData = null
    const req = {
      method,
      url,
      baseUrl: '',
      originalUrl: url,
      body,
      authUser,
      userId: authUser._id,
      headers: { ...headers },
      get(name) {
        return this.headers[name.toLowerCase()]
      },
      is(type) {
        const ct = this.get('content-type') || ''
        if (type === 'image/*') return ct.startsWith('image/')
        return ct.includes(type)
      },
    }
    const res = {
      status(code) {
        statusCode = code
        return this
      },
      set(nameOrObj, val) {
        if (typeof nameOrObj === 'object') {
          Object.assign(responseHeaders, nameOrObj)
        } else {
          responseHeaders[nameOrObj] = val
        }
        return this
      },
      json(data) {
        responseData = data
        resolve({ status: statusCode, headers: responseHeaders, data })
        return this
      },
      send(data) {
        responseData = data
        resolve({ status: statusCode, headers: responseHeaders, data })
        return this
      },
      end() {
        resolve({ status: statusCode, headers: responseHeaders, data: responseData })
      },
    }
    router(req, res, (err) => {
      if (err) resolve({ status: 500, error: err })
      else resolve({ status: statusCode, data: responseData })
    })
  })
}

test('job submission enforces pending job quota per tenant', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const JobModel = {
    countDocuments(filter) {
      assert.equal(String(filter.ownerId), String(ownerId))
      assert.equal(filter.status, 'pending')
      return Promise.resolve(5) // current pending jobs
    },
    prototype: { save: assert.fail },
  }

  const router = createJobsRouter(JobModel, {
    quotaOptions: { maxPendingJobs: 5 },
  })

  const response = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: {
      type: 'custom_task',
      payload: { key: 'value' },
    },
    authUser: { _id: ownerId },
  })

  assert.equal(response.status, 429)
  assert.equal(response.data.error.code, 'JOB_QUOTA_EXCEEDED')
  assert.ok(response.data.error.message.includes('Pending job limit of 5'))
})

test('job submission validates generate_pdf payload before queueing', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const JobModel = {
    countDocuments: async () => 0,
    prototype: { save: assert.fail },
  }

  const router = createJobsRouter(JobModel)

  // Missing sections
  const res1 = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: {
      type: 'generate_pdf',
      payload: { title: 'Valid Title' }, // missing sections
    },
    authUser: { _id: ownerId },
  })
  assert.equal(res1.status, 400)
  assert.equal(res1.data.error.code, 'INVALID_PDF_PAYLOAD')

  // Empty title
  const res2 = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: {
      type: 'generate_pdf',
      payload: { title: '   ', sections: [{ heading: 'H', paragraphs: ['P'] }] },
    },
    authUser: { _id: ownerId },
  })
  assert.equal(res2.status, 400)
  assert.equal(res2.data.error.code, 'INVALID_PDF_PAYLOAD')
})

test('job submission validates process_image payload and verifies tenant asset ownership', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const otherOwnerId = new mongoose.Types.ObjectId()
  const assetId = new mongoose.Types.ObjectId()

  const assets = [
    {
      _id: assetId,
      ownerId: otherOwnerId, // Belongs to other tenant!
      kind: 'upload',
    },
  ]

  const AssetModel = {
    findOne(filter) {
      const match = assets.find(
        (a) =>
          String(a._id) === String(filter._id) &&
          String(a.ownerId) === String(filter.ownerId) &&
          a.kind === filter.kind,
      )
      return { lean: async () => match ?? null }
    },
  }

  const JobModel = {
    countDocuments: async () => 0,
  }

  const router = createJobsRouter(JobModel, { AssetModel })

  // Case 1: Invalid image operation
  const res1 = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: {
      type: 'process_image',
      payload: { assetId: String(assetId), operation: 'invalid_op' },
    },
    authUser: { _id: ownerId },
  })
  assert.equal(res1.status, 400)
  assert.equal(res1.data.error.code, 'INVALID_IMAGE_PAYLOAD')

  // Case 2: Asset belongs to another tenant
  const res2 = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: {
      type: 'process_image',
      payload: { assetId: String(assetId), operation: 'thumbnail' },
    },
    authUser: { _id: ownerId },
  })
  assert.equal(res2.status, 400)
  assert.equal(res2.data.error.code, 'INVALID_IMAGE_ASSET')
  assert.ok(res2.data.error.message.includes('not found for this account'))

  // Case 3: Asset belongs to the authenticated tenant
  assets[0].ownerId = ownerId
  let savedJob = null
  function MockJob(data) {
    this.data = data
    this.save = async () => {
      savedJob = { _id: 'job-123', ...data }
      return savedJob
    }
  }
  MockJob.countDocuments = async () => 0

  const routerSuccess = createJobsRouter(MockJob, { AssetModel })
  const res3 = await invokeRouter(routerSuccess, {
    method: 'POST',
    url: '/',
    body: {
      type: 'process_image',
      payload: { assetId: String(assetId), operation: 'thumbnail' },
    },
    authUser: { _id: ownerId },
  })
  assert.equal(res3.status, 201)
  assert.equal(res3.data.success, true)
  assert.equal(savedJob.type, 'process_image')
})

test('upload image enforces user storage quota and upload count limit', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const mockImageBuffer = Buffer.from('mock-normalized-png-data')

  const AssetModelQuotaExceeded = {
    aggregate: async () => [{ totalBytes: 60 * 1024 * 1024, uploadCount: 10 }],
    create: assert.fail,
  }

  const routerQuota = createUploadsRouter({
    AssetModel: AssetModelQuotaExceeded,
    store: { save: assert.fail },
    imageProcessor: () => ({
      metadata: async () => ({ format: 'png', width: 200, height: 200 }),
      rotate() {
        return this
      },
      toFormat() {
        return this
      },
      toBuffer: async () => mockImageBuffer,
    }),
    quotaOptions: {
      maxStorageBytes: 50 * 1024 * 1024,
      maxUploadCount: 50,
    },
  })

  const res1 = await invokeRouter(routerQuota, {
    method: 'POST',
    url: '/images',
    body: Buffer.from('raw-image-bytes'),
    headers: { 'content-type': 'image/png' },
    authUser: { _id: ownerId },
  })

  assert.equal(res1.status, 429)
  assert.equal(res1.data.error.code, 'STORAGE_QUOTA_EXCEEDED')

  // Test upload count quota
  const AssetModelCountExceeded = {
    aggregate: async () => [{ totalBytes: 1024, uploadCount: 20 }],
    create: assert.fail,
  }

  const routerCount = createUploadsRouter({
    AssetModel: AssetModelCountExceeded,
    store: { save: assert.fail },
    imageProcessor: () => ({
      metadata: async () => ({ format: 'png', width: 200, height: 200 }),
      rotate() {
        return this
      },
      toFormat() {
        return this
      },
      toBuffer: async () => mockImageBuffer,
    }),
    quotaOptions: {
      maxStorageBytes: 50 * 1024 * 1024,
      maxUploadCount: 20,
    },
  })

  const res2 = await invokeRouter(routerCount, {
    method: 'POST',
    url: '/images',
    body: Buffer.from('raw-image-bytes'),
    headers: { 'content-type': 'image/png' },
    authUser: { _id: ownerId },
  })

  assert.equal(res2.status, 429)
  assert.equal(res2.data.error.code, 'STORAGE_QUOTA_EXCEEDED')
  assert.ok(res2.data.error.message.includes('Upload limit of 20 images reached'))
})

test('concurrent simultaneous job requests respect pending job quota without race conditions', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  let pendingCount = 3
  const maxPendingJobs = 5
  const createdJobs = []

  const ReservationModel = createInMemoryReservationStore()

  function ConcurrentJob(data) {
    this.data = data
    this.save = async () => {
      await new Promise((r) => setTimeout(r, 10))
      pendingCount += 1
      const record = { _id: `job-${createdJobs.length + 1}`, ...data }
      createdJobs.push(record)
      return record
    }
  }
  ConcurrentJob.countDocuments = async () => {
    await new Promise((r) => setTimeout(r, 2))
    return pendingCount
  }

  const router = createJobsRouter(ConcurrentJob, {
    quotaOptions: { maxPendingJobs },
    ReservationModel,
  })

  const requests = Array.from({ length: 10 }, (_, i) =>
    invokeRouter(router, {
      method: 'POST',
      url: '/',
      body: {
        type: 'custom_task',
        payload: { index: i },
      },
      authUser: { _id: ownerId },
    }),
  )

  const responses = await Promise.all(requests)

  const successful = responses.filter((r) => r.status === 201)
  const rateLimited = responses.filter((r) => r.status === 429)

  assert.equal(successful.length, 2, 'Exactly 2 slots were available (5 - 3 = 2), so exactly 2 requests must succeed')
  assert.equal(rateLimited.length, 8, 'Remaining 8 concurrent requests must receive 429')
  for (const denied of rateLimited) {
    assert.equal(denied.data.error.code, 'JOB_QUOTA_EXCEEDED')
  }
  assert.equal(createdJobs.length, 2)
  assert.equal(pendingCount, 5, 'Total pending jobs must reach exactly 5, never exceeding quota')
})

test('failed job creation safely releases quota reservation for subsequent requests', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  let pendingCount = 4
  const maxPendingJobs = 5
  let shouldFail = true
  const createdJobs = []

  const ReservationModel = createInMemoryReservationStore()

  function JobWithFailure(data) {
    this.data = data
    this.save = async () => {
      if (shouldFail) {
        throw new Error('Database write failure')
      }
      pendingCount += 1
      const record = { _id: 'job-ok', ...data }
      createdJobs.push(record)
      return record
    }
  }
  JobWithFailure.countDocuments = async () => pendingCount

  const router = createJobsRouter(JobWithFailure, {
    quotaOptions: { maxPendingJobs },
    ReservationModel,
  })

  const res1 = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: { type: 'custom_task', payload: {} },
    authUser: { _id: ownerId },
  })
  assert.equal(res1.status, 500)

  shouldFail = false
  const res2 = await invokeRouter(router, {
    method: 'POST',
    url: '/',
    body: { type: 'custom_task', payload: {} },
    authUser: { _id: ownerId },
  })
  assert.equal(res2.status, 201)
  assert.equal(createdJobs.length, 1)
})

test('concurrent simultaneous image uploads respect upload count limit without race conditions', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const ReservationModel = createInMemoryReservationStore()
  let uploadCount = 18
  const maxUploadCount = 20
  const createdAssets = []

  const AssetModel = {
    aggregate: async () => [{ totalBytes: 1000, uploadCount }],
    create: async (data) => {
      await new Promise((r) => setTimeout(r, 10))
      uploadCount += 1
      const asset = { _id: `asset-${createdAssets.length + 1}`, ...data }
      createdAssets.push(asset)
      return asset
    },
  }

  const mockImageBuffer = Buffer.from('mock-png-buffer')
  const store = {
    save: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return { storageKey: 'uploads/mock.png', sizeBytes: 100 }
    },
    remove: async () => true,
  }

  const router = createUploadsRouter({
    AssetModel,
    store,
    imageProcessor: () => ({
      metadata: async () => ({ format: 'png', width: 200, height: 200 }),
      rotate() { return this },
      toFormat() { return this },
      toBuffer: async () => mockImageBuffer,
    }),
    quotaOptions: {
      maxStorageBytes: 50 * 1024 * 1024,
      maxUploadCount,
    },
    ReservationModel,
  })

  const uploads = Array.from({ length: 6 }, () =>
    invokeRouter(router, {
      method: 'POST',
      url: '/images',
      body: Buffer.from('raw-png-data'),
      headers: { 'content-type': 'image/png' },
      authUser: { _id: ownerId },
    }),
  )

  const responses = await Promise.all(uploads)
  const successful = responses.filter((r) => r.status === 201)
  const denied = responses.filter((r) => r.status === 429)

  assert.equal(successful.length, 2, 'Exactly 2 uploads must succeed')
  assert.equal(denied.length, 4, 'Remaining 4 uploads must be denied with 429')
  assert.equal(createdAssets.length, 2)
  for (const d of denied) {
    assert.equal(d.data.error.code, 'STORAGE_QUOTA_EXCEEDED')
  }
})

test('concurrent simultaneous image uploads respect byte storage quota without race conditions', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const ReservationModel = createInMemoryReservationStore()
  let totalBytes = 200
  const maxStorageBytes = 1000
  const createdAssets = []

  const AssetModel = {
    aggregate: async () => [{ totalBytes, uploadCount: 1 }],
    create: async (data) => {
      await new Promise((r) => setTimeout(r, 10))
      totalBytes += data.sizeBytes
      const asset = { _id: `asset-${createdAssets.length + 1}`, ...data }
      createdAssets.push(asset)
      return asset
    },
  }

  const imageBytes = 350
  const mockImageBuffer = Buffer.alloc(imageBytes)
  const store = {
    save: async () => ({ storageKey: 'uploads/mock.png', sizeBytes: imageBytes }),
    remove: async () => true,
  }

  const router = createUploadsRouter({
    AssetModel,
    store,
    imageProcessor: () => ({
      metadata: async () => ({ format: 'png', width: 200, height: 200 }),
      rotate() { return this },
      toFormat() { return this },
      toBuffer: async () => mockImageBuffer,
    }),
    quotaOptions: {
      maxStorageBytes,
      maxUploadCount: 50,
    },
    ReservationModel,
  })

  const uploads = Array.from({ length: 5 }, () =>
    invokeRouter(router, {
      method: 'POST',
      url: '/images',
      body: Buffer.from('raw-png-data'),
      headers: { 'content-type': 'image/png' },
      authUser: { _id: ownerId },
    }),
  )

  const responses = await Promise.all(uploads)
  const successful = responses.filter((r) => r.status === 201)
  const denied = responses.filter((r) => r.status === 429)

  assert.equal(successful.length, 2, 'Only 2 uploads can fit into 800 available bytes')
  assert.equal(denied.length, 3, 'Remaining 3 uploads exceed byte quota')
  assert.equal(createdAssets.length, 2)
  for (const d of denied) {
    assert.equal(d.data.error.code, 'STORAGE_QUOTA_EXCEEDED')
  }
})

test('failed image upload releases storage reservation for subsequent uploads', async () => {
  const ownerId = new mongoose.Types.ObjectId()
  const ReservationModel = createInMemoryReservationStore()
  let shouldFail = true
  let uploadCount = 19
  const maxUploadCount = 20

  const AssetModel = {
    aggregate: async () => [{ totalBytes: 500, uploadCount }],
    create: async () => {
      if (shouldFail) throw new Error('Asset DB insert failure')
      uploadCount += 1
      return { _id: 'asset-ok', sizeBytes: 100 }
    },
  }

  let cleanedUpKey = null
  const store = {
    save: async () => ({ storageKey: 'uploads/temp.png', sizeBytes: 100 }),
    remove: async (owner, key) => {
      cleanedUpKey = key
      return true
    },
  }

  const router = createUploadsRouter({
    AssetModel,
    store,
    imageProcessor: () => ({
      metadata: async () => ({ format: 'png', width: 200, height: 200 }),
      rotate() { return this },
      toFormat() { return this },
      toBuffer: async () => Buffer.from('img-buffer'),
    }),
    quotaOptions: {
      maxStorageBytes: 10000,
      maxUploadCount,
    },
    ReservationModel,
  })

  const res1 = await invokeRouter(router, {
    method: 'POST',
    url: '/images',
    body: Buffer.from('raw-bytes'),
    headers: { 'content-type': 'image/png' },
    authUser: { _id: ownerId },
  })
  assert.equal(res1.status, 500)
  assert.equal(cleanedUpKey, 'uploads/temp.png', 'Failed upload cleaned up file from store')

  shouldFail = false
  const res2 = await invokeRouter(router, {
    method: 'POST',
    url: '/images',
    body: Buffer.from('raw-bytes'),
    headers: { 'content-type': 'image/png' },
    authUser: { _id: ownerId },
  })
  assert.equal(res2.status, 201)
})
