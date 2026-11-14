import mongoose from 'mongoose'

const emailQuotaSchema = new mongoose.Schema(
  {
    scopeKey: {
      type: String,
      required: true,
      maxlength: 64,
    },
    windowType: {
      type: String,
      enum: ['minute', 'day'],
      required: true,
    },
    windowStart: {
      type: Date,
      required: true,
    },
    count: {
      type: Number,
      min: 0,
      required: true,
      default: 0,
      validate: Number.isInteger,
    },
  },
  { timestamps: true },
)

emailQuotaSchema.index(
  { scopeKey: 1, windowType: 1, windowStart: 1 },
  { unique: true },
)
emailQuotaSchema.index({ windowStart: 1 }, { expireAfterSeconds: 2_592_000 })

const EmailQuota =
  mongoose.models.EmailQuota ??
  mongoose.model('EmailQuota', emailQuotaSchema)

export default EmailQuota
