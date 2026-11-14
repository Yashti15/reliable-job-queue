import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import mongoose from 'mongoose'
import sharp from 'sharp'
import { test } from 'node:test'
import { createEmailHandler } from './email-handler.js'
import { createImageHandler } from './image-handler.js'
import { createPdfHandler } from './pdf-handler.js'
import { getRegisteredJobTypes } from './job-handlers.js'
import { validateImagePayload } from './job-payloads.js'
import { createFileStore } from '../storage/file-store.js'

const ownerId = new mongoose.Types.ObjectId().toString()
const jobId = new mongoose.Types.ObjectId().toString()
const emailJob = { _id: jobId, ownerId, replayCount: 0 }
const enabledEmailPolicy = {
  enabled: true,
  configured: true,
  allowedRecipients: ['@example.test'],
  dailyUserQuota: 5,
  dailyGlobalQuota: 100,
  perMinuteUserLimit: 3,
}
const allowEmailQuota = async () => ({ allowed: true })

test('handler registry exposes all real job types', () => {
  assert.deepEqual(getRegisteredJobTypes(), ['send_email', 'generate_pdf', 'process_image'])
})

test('file store uses JOB_STORAGE_DIR loaded after module initialization', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-storage-config-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const previous = process.env.JOB_STORAGE_DIR
  process.env.JOB_STORAGE_DIR = root
  try {
    const store = createFileStore()
    assert.equal(store.root, path.resolve(root))
    const saved = await store.save(ownerId, 'outputs', 'pdf', Buffer.from('private'))
    assert.equal(
      (await store.load(ownerId, saved.storageKey, 'outputs')).toString(),
      'private',
    )
  } finally {
    if (previous === undefined) delete process.env.JOB_STORAGE_DIR
    else process.env.JOB_STORAGE_DIR = previous
  }
})

test('email validates recipient and requires configured provider credentials', async () => {
  const handler = createEmailHandler({
    getConfig: () => ({ apiKey: '', from: '', timeoutMs: 1000 }),
    getPolicy: () => enabledEmailPolicy,
    fetchImpl: async () => assert.fail('Provider must not be called without configuration.'),
  })

  await assert.rejects(handler({ to: 'not-an-address', subject: 'Hi', text: 'Body' }), {
    name: 'InvalidJobPayloadError',
  })
  await assert.rejects(
    handler(
      { to: 'learner@example.test', subject: 'Hi', text: 'Body' },
      { job: emailJob },
    ),
    /Email delivery is not configured/,
  )
})

test('email sends a validated message and returns provider acceptance metadata only', async () => {
  let request
  const handler = createEmailHandler({
    getConfig: () => ({
      apiKey: 'secret-test-key',
      from: 'QueueOps <queue@example.test>',
      timeoutMs: 1000,
    }),
    getPolicy: () => enabledEmailPolicy,
    reserveQuota: allowEmailQuota,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) }
      return { ok: true, status: 200, json: async () => ({ id: 'provider-id-1' }) }
    },
  })

  const result = await handler(
    {
      to: 'learner@example.test',
      subject: 'Queue report',
      text: 'Plain text',
      html: '<p>HTML</p>',
    },
    { job: emailJob },
  )

  assert.equal(request.url, 'https://api.resend.com/emails')
  assert.equal(request.options.headers.Authorization, 'Bearer secret-test-key')
  assert.equal(request.options.headers['Idempotency-Key'], `rq-${jobId}-0`)
  assert.deepEqual(request.body, {
    from: 'QueueOps <queue@example.test>',
    to: 'learner@example.test',
    subject: 'Queue report',
    text: 'Plain text',
    html: '<p>HTML</p>',
  })
  assert.deepEqual(result, {
    type: 'email',
    provider: 'resend',
    status: 'accepted',
    providerMessageId: 'provider-id-1',
  })
  assert.doesNotMatch(JSON.stringify(result), /secret-test-key|Plain text|<p>/)
})

test('email provider rejection is safe and transient responses can be retried', async () => {
  const message = { to: 'learner@example.test', subject: 'Hi', text: 'Body' }
  const config = () => ({ apiKey: 'secret', from: 'sender@example.test', timeoutMs: 1000 })
  const rejected = createEmailHandler({
    getConfig: config,
    getPolicy: () => enabledEmailPolicy,
    reserveQuota: allowEmailQuota,
    fetchImpl: async () => ({ ok: false, status: 400 }),
  })
  await assert.rejects(rejected(message, { job: emailJob }), /Email provider rejected/)

  const rateLimited = createEmailHandler({
    getConfig: config,
    getPolicy: () => enabledEmailPolicy,
    reserveQuota: allowEmailQuota,
    fetchImpl: async () => ({ ok: false, status: 429 }),
  })
  await assert.rejects(
    rateLimited(message, { job: emailJob }),
    /temporarily unavailable/,
  )
})

test('email timeout is surfaced as a retryable safe error', async () => {
  const handler = createEmailHandler({
    getConfig: () => ({ apiKey: 'secret', from: 'sender@example.test', timeoutMs: 100 }),
    getPolicy: () => enabledEmailPolicy,
    reserveQuota: allowEmailQuota,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })
      }),
  })

  await assert.rejects(
    handler(
      { to: 'learner@example.test', subject: 'Hi', text: 'Body' },
      { job: emailJob },
    ),
    /timed out/,
  )
})

test('email sender fails closed when shared-provider sending is disabled', async () => {
  const handler = createEmailHandler({
    getConfig: () => ({
      apiKey: 'secret-test-key',
      from: 'sender@example.test',
      timeoutMs: 1000,
    }),
    getPolicy: () => ({
      enabled: false,
      configured: false,
      allowedRecipients: [],
      configurationMessage: 'Shared-provider email sending is disabled.',
    }),
    fetchImpl: async () => assert.fail('Provider must not be called when disabled.'),
  })

  await assert.rejects(
    handler(
      { to: 'learner@example.test', subject: 'Hi', text: 'Body' },
      { job: emailJob },
    ),
    /disabled/,
  )
})

test('email sender enforces recipient allowlist independently of API validation', async () => {
  const handler = createEmailHandler({
    getConfig: () => ({
      apiKey: 'secret-test-key',
      from: 'sender@example.test',
      timeoutMs: 1000,
    }),
    getPolicy: () => enabledEmailPolicy,
    fetchImpl: async () => assert.fail('Disallowed recipients must not reach provider.'),
  })

  await assert.rejects(
    handler(
      { to: 'outside@attacker.test', subject: 'Hi', text: 'Body' },
      { job: emailJob },
    ),
    /not permitted/,
  )
})

test('email sender reserves owner-scoped execution quota before contacting provider', async () => {
  let quotaRequest
  const handler = createEmailHandler({
    getConfig: () => ({
      apiKey: 'secret-test-key',
      from: 'sender@example.test',
      timeoutMs: 1000,
    }),
    getPolicy: () => enabledEmailPolicy,
    reserveQuota: async (options) => {
      quotaRequest = options
      return { allowed: false, code: 'EMAIL_RATE_LIMITED' }
    },
    fetchImpl: async () => assert.fail('Provider must not be called when quota is exhausted.'),
  })

  await assert.rejects(
    handler(
      { to: 'learner@example.test', subject: 'Hi', text: 'Body' },
      { job: emailJob },
    ),
    { name: 'EmailQuotaExceededError' },
  )
  assert.equal(quotaRequest.ownerId, ownerId)
  assert.equal(quotaRequest.usage, 'execution')
})

test('PDF handler generates a non-empty PDF with owner-scoped output and reuses it', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-pdf-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const assets = createAssetModel()
  const handler = createPdfHandler({ AssetModel: assets.model, store })
  const payload = {
    title: 'Weekly queue report',
    sections: [{ heading: 'Completed', paragraphs: ['Twelve jobs completed successfully.'] }],
  }

  const result = await handler(payload, { job: { _id: jobId, ownerId } })
  const artifact = result.artifacts[0]
  const buffer = await store.load(ownerId, assets.records[0].storageKey, 'outputs')
  assert.equal(buffer.subarray(0, 5).toString(), '%PDF-')
  assert.ok(buffer.length > 500)
  assert.equal(artifact.mediaType, 'application/pdf')

  const repeated = await handler(payload, { job: { _id: jobId, ownerId } })
  assert.equal(repeated.artifacts[0].assetId, artifact.assetId)
  assert.equal(assets.records.length, 1)
})

test('PDF handler rejects invalid report content without writing a file', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-pdf-invalid-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const assets = createAssetModel()
  const handler = createPdfHandler({
    AssetModel: assets.model,
    store: createFileStore({ root }),
  })

  await assert.rejects(
    handler({ title: '../unsafe', sections: [] }, { job: { _id: jobId, ownerId } }),
    { name: 'InvalidJobPayloadError' },
  )
  assert.equal(assets.records.length, 0)
})

test('image handler resizes, converts, records dimensions, and safely reuses output', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-image-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const assets = createAssetModel()
  const source = await sharp({
    create: { width: 40, height: 20, channels: 3, background: '#55aaee' },
  })
    .jpeg()
    .toBuffer()
  const saved = await store.save(ownerId, 'uploads', 'jpg', source)
  const inputAsset = await assets.model.create({
    ownerId,
    kind: 'upload',
    storageKey: saved.storageKey,
    fileName: 'source.jpg',
    mediaType: 'image/jpeg',
    sizeBytes: saved.sizeBytes,
    width: 40,
    height: 20,
  })
  const handler = createImageHandler({ AssetModel: assets.model, store })
  const result = await handler(
    { assetId: String(inputAsset._id), operation: 'resize', width: 10, format: 'png' },
    { job: { _id: jobId, ownerId } },
  )

  assert.equal(result.type, 'image')
  assert.equal(result.width, 10)
  assert.equal(result.height, 5)
  assert.equal(result.format, 'png')
  const outputAsset = assets.records.find((asset) => asset.kind === 'output')
  const output = await store.load(ownerId, outputAsset.storageKey, 'outputs')
  const metadata = await sharp(output).metadata()
  assert.equal(metadata.format, 'png')
  assert.equal(metadata.width, 10)
  assert.equal(metadata.height, 5)

  const repeated = await handler(
    { assetId: String(inputAsset._id), operation: 'resize', width: 10, format: 'png' },
    { job: { _id: jobId, ownerId } },
  )
  assert.equal(repeated.artifacts[0].assetId, result.artifacts[0].assetId)
  assert.equal(assets.records.filter((asset) => asset.kind === 'output').length, 1)
})

test('image handler supports fixed thumbnails and rejects corrupted input', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rq-image-invalid-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const store = createFileStore({ root })
  const assets = createAssetModel()
  const corrupted = await store.save(ownerId, 'uploads', 'png', Buffer.from('not an image'))
  const asset = await assets.model.create({
    ownerId,
    kind: 'upload',
    storageKey: corrupted.storageKey,
    fileName: 'source.png',
    mediaType: 'image/png',
    sizeBytes: corrupted.sizeBytes,
  })
  const handler = createImageHandler({ AssetModel: assets.model, store })

  await assert.rejects(
    handler(
      { assetId: String(asset._id), operation: 'thumbnail' },
      { job: { _id: jobId, ownerId } },
    ),
    /corrupt or uses an unsupported format/,
  )
  assert.throws(
    () => validateImagePayload({ sourceUrl: 'http://127.0.0.1/private', operation: 'thumbnail' }),
    { name: 'InvalidJobPayloadError' },
  )
  await assert.rejects(
    store.load(ownerId, '..\\..\\outside.png', 'uploads'),
    /Invalid stored file key/,
  )
})

function createAssetModel() {
  const records = []
  return {
    records,
    model: {
      async create(data) {
        const record = { _id: new mongoose.Types.ObjectId(), ...data }
        records.push(record)
        return record
      },
      findOne(filter) {
        return {
          lean: async () => {
            return records.find((record) =>
              Object.entries(filter).every(([key, value]) => {
                if (key === '_id') return String(record[key]) === String(value)
                if (key === 'mediaType' && value?.$in) return value.$in.includes(record[key])
                return String(record[key]) === String(value)
              }),
            )
          },
        }
      },
    },
  }
}
