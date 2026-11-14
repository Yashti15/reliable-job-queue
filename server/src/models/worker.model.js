import mongoose from 'mongoose'

const workerSchema = new mongoose.Schema(
  {
    workerId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 200,
    },
    status: {
      type: String,
      enum: ['active', 'stopped'],
      required: true,
      default: 'active',
    },
    lastSeenAt: {
      type: Date,
      required: true,
    },
    startedAt: {
      type: Date,
      required: true,
    },
    stoppedAt: {
      type: Date,
    },
    currentJobId: {
      type: String,
    },
    currentJobType: {
      type: String,
      maxlength: 200,
    },
    currentJobOwnerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    processId: {
      type: Number,
    },
    host: {
      type: String,
      maxlength: 200,
    },
  },
  { timestamps: true },
)

workerSchema.index({ lastSeenAt: -1 })
workerSchema.index({ currentJobOwnerId: 1, lastSeenAt: -1 })
workerSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 2_592_000 })

const Worker = mongoose.models.Worker ?? mongoose.model('Worker', workerSchema)

export default Worker
