import mongoose from 'mongoose'

const queueEventSchema = new mongoose.Schema(
  {
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    name: {
      type: String,
      required: true,
      enum: [
        'job:created',
        'job:claimed',
        'job:progress',
        'job:completed',
        'job:failed',
        'job:retried',
        'job:dead',
        'job:replayed',
        'job:cancelled',
        'worker:updated',
        'worker:heartbeat',
      ],
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
)

queueEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 86_400 })
queueEventSchema.index({ ownerId: 1, _id: 1 })

const QueueEvent =
  mongoose.models.QueueEvent ?? mongoose.model('QueueEvent', queueEventSchema)

export default QueueEvent
