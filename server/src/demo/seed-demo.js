import dotenv from 'dotenv'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import sharp from 'sharp'
import { connectDatabase } from '../config/db.js'
import Job from '../models/job.model.js'
import JobAsset from '../models/job-asset.model.js'
import User from '../models/user.model.js'
import { fileStore } from '../storage/file-store.js'

dotenv.config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) })

const DEMO_EMAIL = process.env.DEMO_USER_EMAIL || 'demo@example.test'
const DEMO_PASSWORD = process.env.DEMO_USER_PASSWORD || 'DemoPassword123!'

export async function seedDemoData({
  email = DEMO_EMAIL,
  password = DEMO_PASSWORD,
  store = fileStore,
  logger = console,
} = {}) {
  await Job.init()
  await JobAsset.init()
  await User.init()

  // 1. Safe demo account setup (never overwriting existing users)
  let user = await User.findOne({ email }).select('+passwordHash')
  let isNewUser = false
  if (!user) {
    const passwordHash = await bcrypt.hash(password, 10)
    user = await User.create({
      name: 'Demo Operator',
      email,
      passwordHash,
    })
    isNewUser = true
    logger.info?.(`✓ Created demo user: ${email}`)
  } else {
    logger.info?.(`✓ Reusing existing demo user: ${email} (${user._id})`)
  }

  const createdJobs = []

  // 2. Sample PDF Job
  const existingPdfJob = await Job.findOne({
    ownerId: user._id,
    idempotencyKey: 'demo-pdf-report-v1',
  })
  if (!existingPdfJob) {
    const pdfJob = await Job.create({
      ownerId: user._id,
      type: 'generate_pdf',
      status: 'pending',
      priority: 'normal',
      idempotencyKey: 'demo-pdf-report-v1',
      maxAttempts: 3,
      payload: {
        title: 'Quarterly Infrastructure & Queue Health Report',
        sections: [
          {
            heading: 'Executive Summary',
            paragraphs: [
              'The background queue platform executed 1,240,000 tasks across all tenant partitions during Q3 with 99.98% availability.',
              'Zero job loss was observed during rolling worker deployments, verified by MongoDB lease timeouts and automatic recovery.',
            ],
          },
          {
            heading: 'Reliability & Fault-Tolerance',
            paragraphs: [
              'A total of 42 worker crash events were recovered automatically via conditional lease expiration checks.',
              'Exponential backoff with jitter prevented downstream thundering herd effects on upstream partner APIs.',
            ],
          },
        ],
      },
    })
    createdJobs.push({ type: 'generate_pdf', id: pdfJob._id, status: 'pending' })
  }

  // 3. Sample Image Processing Job with real uploaded asset
  const existingImageJob = await Job.findOne({
    ownerId: user._id,
    idempotencyKey: 'demo-image-thumbnail-v1',
  })
  if (!existingImageJob) {
    const sampleImageBytes = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 30, g: 58, b: 138 },
      },
    })
      .png()
      .toBuffer()

    const savedUpload = await store.save(user._id, 'uploads', 'png', sampleImageBytes)
    const asset = await JobAsset.create({
      ownerId: user._id,
      kind: 'upload',
      storageKey: savedUpload.storageKey,
      fileName: 'architecture-diagram.png',
      mediaType: 'image/png',
      sizeBytes: savedUpload.sizeBytes,
      width: 400,
      height: 300,
    })

    const imageJob = await Job.create({
      ownerId: user._id,
      type: 'process_image',
      status: 'pending',
      priority: 'high',
      idempotencyKey: 'demo-image-thumbnail-v1',
      maxAttempts: 3,
      payload: {
        assetId: String(asset._id),
        operation: 'thumbnail',
        format: 'webp',
      },
    })
    createdJobs.push({ type: 'process_image', id: imageJob._id, status: 'pending' })
  }

  // 4. Sample Email Job (mocked in demo mode)
  const existingEmailJob = await Job.findOne({
    ownerId: user._id,
    idempotencyKey: 'demo-email-mocked-v1',
  })
  if (!existingEmailJob) {
    const emailJob = await Job.create({
      ownerId: user._id,
      type: 'send_email',
      status: 'pending',
      priority: 'normal',
      idempotencyKey: 'demo-email-mocked-v1',
      maxAttempts: 3,
      payload: {
        to: 'demo-team@example.test',
        subject: 'QueueOps Initial Demo Notification',
        text: 'Your demo environment has initialized successfully with mocked delivery safeguards enabled.',
      },
    })
    createdJobs.push({ type: 'send_email', id: emailJob._id, status: 'pending' })
  }

  // 5. Sample Dead-Letter Queue Job (demonstrating DLQ and manual replay)
  const existingDlqJob = await Job.findOne({
    ownerId: user._id,
    idempotencyKey: 'demo-dead-letter-v1',
  })
  if (!existingDlqJob) {
    const dlqJob = await Job.create({
      ownerId: user._id,
      type: 'send_email',
      status: 'dead',
      priority: 'low',
      attempts: 3,
      maxAttempts: 3,
      deadAt: new Date(),
      idempotencyKey: 'demo-dead-letter-v1',
      lastError:
        'DownstreamServiceUnavailableError: External webhook partner endpoint https://partner.example.test/webhook returned 503 after 3 retries.',
      payload: {
        to: 'failing-webhook@example.test',
        subject: 'Webhook Delivery Event',
        text: 'Simulated exhausted webhook attempt demonstrating dead-letter recovery.',
      },
    })
    createdJobs.push({ type: 'send_email (DLQ)', id: dlqJob._id, status: 'dead' })
  }

  return {
    user: { id: String(user._id), email: user.email, isNew: isNewUser },
    password,
    createdJobs,
  }
}

async function main() {
  await connectDatabase()
  try {
    const result = await seedDemoData()
    console.log('\n=======================================================')
    console.log('   Reliable Job Queue - Demo Environment Ready')
    console.log('=======================================================')
    console.log('Demo Credentials:')
    console.log(`  Email:    ${result.user.email}`)
    console.log(`  Password: ${result.password}`)
    console.log('\nSample Jobs Initialized:')
    if (result.createdJobs.length === 0) {
      console.log('  (Sample jobs already exist for this account; none duplicated)')
    } else {
      for (const job of result.createdJobs) {
        console.log(`  - [${job.status.toUpperCase()}] ${job.type} (${job.id})`)
      }
    }
    console.log('\nDemonstration Checklist:')
    console.log('  1. Login to the dashboard at http://localhost:5173')
    console.log('  2. Observe live stats and pending jobs')
    console.log('  3. Start a worker ("npm run worker --prefix server") to watch execution live')
    console.log('  4. Visit the "Dead Jobs" tab and click "Replay" to test recovery')
    console.log('=======================================================\n')
  } finally {
    await mongoose.disconnect()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('Demo seed failed:', error.message)
    process.exitCode = 1
  })
}
