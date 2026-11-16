import mongoose from 'mongoose'

const jobAssetSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    jobId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Job',
      required: function requireJobForOutputs() {
        return this.kind === 'output'
      },
    },
    kind: {
      type: String,
      enum: ['upload', 'output'],
      required: true,
    },
    storageKey: {
      type: String,
      required: true,
      unique: true,
      match: /^[0-9a-f-]{36}\.(?:pdf|jpg|png|webp)$/,
    },
    fileName: {
      type: String,
      required: true,
      maxlength: 120,
    },
    mediaType: {
      type: String,
      enum: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'],
      required: true,
    },
    sizeBytes: {
      type: Number,
      required: true,
      min: 1,
      max: 10 * 1024 * 1024,
    },
    cleanupPending: {
      type: Boolean,
      default: false,
    },
    cleanupPendingAt: Date,
    width: {
      type: Number,
      min: 1,
      max: 4000,
    },
    height: {
      type: Number,
      min: 1,
      max: 4000,
    },
  },
  { timestamps: true },
)

jobAssetSchema.index({ ownerId: 1, jobId: 1, kind: 1 })
jobAssetSchema.index({ createdAt: 1 })
jobAssetSchema.index(
  { cleanupPending: 1 },
  { partialFilterExpression: { cleanupPending: true } },
)
jobAssetSchema.index(
  { ownerId: 1, jobId: 1 },
  { unique: true, partialFilterExpression: { kind: 'output' } },
)

const JobAsset =
  mongoose.models.JobAsset ?? mongoose.model('JobAsset', jobAssetSchema)

export default JobAsset
