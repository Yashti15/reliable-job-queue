import mongoose from 'mongoose'

const quotaReservationSchema = new mongoose.Schema(
  {
    scopeKey: {
      type: String,
      required: true,
      unique: true,
      maxlength: 128,
    },
    count: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    reservations: [
      {
        token: { type: String, required: true },
        amount: { type: Number, required: true, min: 1 },
        expiresAt: { type: Date, required: true },
      },
    ],
  },
  { timestamps: true },
)

quotaReservationSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 300 })
quotaReservationSchema.index({ 'reservations.expiresAt': 1 })

const QuotaReservation =
  mongoose.models.QuotaReservation ??
  mongoose.model('QuotaReservation', quotaReservationSchema)

export default QuotaReservation
