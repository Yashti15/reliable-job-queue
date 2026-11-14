import assert from 'node:assert/strict'
import express from 'express'
import { mkdtemp, rm } from 'node:fs/promises'
import mongoose from 'mongoose'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { after, before, test } from 'node:test'
import { createJobsRouter } from './jobs.routes.js'
import { createUploadsRouter } from './uploads.routes.js'
import { createFileStore } from '../storage/file-store.js'

const ownerId = new mongoose.Types.ObjectId()
const otherOwnerId = new mongoose.Types.ObjectId()
const jobId = new mongoose.Types.ObjectId()
const artifactId = new mongoose.Types.ObjectId()
const assetRecords = []
let root
let store
let server
let baseUrl
let imageArtifactId

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'rq-artifacts-test-'))
  store = createFileStore({ root })
  const output = await store.save(
    ownerId,
    'outputs',
    'pdf',
    Buffer.from('%PDF-1.7 private report'),
  )
  assetRecords.push({
    _id: artifactId,
    ownerId,
    jobId,
    kind: 'output',
    storageKey: output.storageKey,
    fileName: 'report.pdf',
    mediaType: 'application/pdf',
    sizeBytes: output.sizeBytes,
  })
  const imageBytes = await sharp({
    create: { width: 8, height: 6, channels: 3, background: '#478be0' },
  })
    .png()
    .toBuffer()
  const imageOutput = await store.save(ownerId, 'outputs', 'png', imageBytes)
  imageArtifactId = new mongoose.Types.ObjectId()
  assetRecords.push({
    _id: imageArtifactId,
    ownerId,
    jobId,
    kind: 'output',
    storageKey: imageOutput.storageKey,
    fileName: 'processed.png',
    mediaType: 'image/png',
    sizeBytes: imageOutput.sizeBytes,
  })

  const job = {
    _id: jobId,
    ownerId,
    status: 'completed',
    result: {
      type: 'pdf',
      title: 'Private report',
      artifacts: [
        {
          assetId: String(artifactId),
          fileName: 'report.pdf',
          mediaType: 'application/pdf',
          sizeBytes: output.sizeBytes,
        },
        {
          assetId: String(imageArtifactId),
          fileName: 'processed.png',
          mediaType: 'image/png',
          sizeBytes: imageOutput.sizeBytes,
        },
      ],
    },
  }
  const JobModel = {
    findOne(filter) {
      const ownerMatches = String(filter.ownerId) === String(ownerId)
      const matches =
        ownerMatches &&
        String(filter._id) === String(jobId) &&
        filter.status === 'completed'
      return { lean: async () => (matches ? job : null) }
    },
  }
  const AssetModel = {
    findOne(filter) {
      const asset = assetRecords.find(
        (record) =>
          String(record._id) === String(filter._id) &&
          String(record.ownerId) === String(filter.ownerId) &&
          String(record.jobId) === String(filter.jobId) &&
          record.kind === filter.kind,
      )
      return { lean: async () => asset ?? null }
    },
    async create(record) {
      const created = { _id: new mongoose.Types.ObjectId(), ...record }
      assetRecords.push(created)
      return created
    },
  }

  const app = express()
  app.use('/api', (request, _response, next) => {
    request.authUser = {
      _id: request.get('x-test-owner') || ownerId.toString(),
    }
    next()
  })
  app.use('/api/uploads', express.raw({ type: 'image/*', limit: '5mb' }))
  app.use('/api/uploads', createUploadsRouter({ AssetModel, store }))
  app.use(
    '/api/jobs',
    createJobsRouter(JobModel, {
      AssetModel,
      store,
      eventPublisher: async () => true,
    }),
  )
  app.use((error, _request, response, _next) => {
    response.status(error.status === 413 ? 413 : 400).json({ error: 'invalid body' })
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
  if (root) await rm(root, { recursive: true, force: true })
})

test('image upload validates bytes and records trusted owner-scoped metadata', async () => {
  const image = await sharp({
    create: { width: 20, height: 12, channels: 3, background: '#ff8811' },
  })
    .png()
    .toBuffer()
  const response = await fetch(`${baseUrl}/api/uploads/images`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: image,
  })
  const body = await response.json()

  assert.equal(response.status, 201)
  assert.equal(body.data.asset.width, 20)
  assert.equal(body.data.asset.height, 12)
  const uploaded = assetRecords.find((asset) => asset.kind === 'upload')
  assert.equal(String(uploaded.ownerId), String(ownerId))
  assert.equal(uploaded.mediaType, 'image/png')
})

test('image upload rejects unsupported media types and corrupt image bytes', async () => {
  const unsupported = await fetch(`${baseUrl}/api/uploads/images`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: Buffer.from('not an image'),
  })
  assert.equal(unsupported.status, 415)

  const corrupted = await fetch(`${baseUrl}/api/uploads/images`, {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('not a PNG'),
  })
  assert.equal(corrupted.status, 400)
  assert.equal((await corrupted.json()).error.code, 'INVALID_IMAGE')
})

test('artifact download requires the completed job result and authenticated owner', async () => {
  const url = `${baseUrl}/api/jobs/${jobId}/artifacts/${artifactId}`
  const allowed = await fetch(url)
  assert.equal(allowed.status, 200)
  assert.match(allowed.headers.get('content-disposition'), /^attachment;/)
  assert.equal(allowed.headers.get('cache-control'), 'private, no-store')
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await allowed.text(), /^%PDF-/)

  const wrongOwner = await fetch(url, {
    headers: { 'x-test-owner': otherOwnerId.toString() },
  })
  assert.equal(wrongOwner.status, 404)

  const unlisted = await fetch(
    `${baseUrl}/api/jobs/${jobId}/artifacts/${new mongoose.Types.ObjectId()}`,
  )
  assert.equal(unlisted.status, 404)
})

test('processed image artifacts can be viewed inline only through the authenticated route', async () => {
  const response = await fetch(
    `${baseUrl}/api/jobs/${jobId}/artifacts/${imageArtifactId}`,
  )

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'image/png')
  assert.match(response.headers.get('content-disposition'), /^inline;/)

  const unauthorized = await fetch(
    `${baseUrl}/api/jobs/${jobId}/artifacts/${imageArtifactId}`,
    { headers: { 'x-test-owner': otherOwnerId.toString() } },
  )
  assert.equal(unauthorized.status, 404)
})
