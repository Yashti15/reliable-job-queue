import mongoose from 'mongoose'

const jobSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    type: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 200,
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      validate: {
        validator: (value) =>
          value !== null && typeof value === 'object' && !Array.isArray(value),
        message: 'payload must be an object',
      },
    },
    status: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'failed', 'dead'],
      default: 'pending',
    },
    priority: {
      type: String,
      enum: ['low', 'normal', 'high'],
      default: 'normal',
    },
    attempts: {
      type: Number,
      min: 0,
      default: 0,
      validate: Number.isInteger,
    },
    maxAttempts: {
      type: Number,
      min: 1,
      default: 3,
      validate: Number.isInteger,
    },
    runAt: {
      type: Date,
      default: Date.now,
    },
    lastError: {
      type: String,
      trim: true,
      maxlength: 10000,
    },
    result: {
      type: mongoose.Schema.Types.Mixed,
    },
    workerId: {
      type: String,
      trim: true,
      maxlength: 200,
    },
    claimedAt: {
      type: Date,
    },
    leaseExpiresAt: {
      type: Date,
    },
    claimToken: {
      type: String,
      trim: true,
      maxlength: 100,
    },
    completedAt: {
      type: Date,
    },
    deadAt: {
      type: Date,
    },
    replayCount: {
      type: Number,
      min: 0,
      default: 0,
      validate: Number.isInteger,
    },
    replayHistory: {
      type: [
        new mongoose.Schema(
          {
            replayedAt: { type: Date, required: true },
            previousAttempts: { type: Number, required: true, min: 0 },
            previousLastError: { type: String, maxlength: 10000 },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    idempotencyKey: {
      type: String,
      trim: true,
      maxlength: 200,
      set: (value) =>
        typeof value === 'string' && value.trim() ? value.trim() : undefined,
    },
  },
  { timestamps: true },
)

jobSchema.index(
  { ownerId: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      ownerId: { $type: 'objectId' },
      idempotencyKey: { $type: 'string' },
    },
  },
)
jobSchema.index({ ownerId: 1, status: 1, createdAt: -1 })
jobSchema.index({ ownerId: 1, status: 1, deadAt: -1, _id: -1 })
jobSchema.index({ createdAt: -1 })
jobSchema.index({ status: 1, runAt: 1 })
jobSchema.index({ status: 1, priority: 1, createdAt: 1, _id: 1, runAt: 1 })
jobSchema.index(
  { status: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { status: 'processing' } },
)
jobSchema.index(
  { status: 1, priority: 1, createdAt: 1, _id: 1, leaseExpiresAt: 1 },
  { partialFilterExpression: { status: 'processing' } },
)

const Job = mongoose.models.Job ?? mongoose.model('Job', jobSchema)

export default Job
