import EmailQuota from '../models/email-quota.model.js'

export function getQuotaWindowStart(windowType, now = new Date()) {
  const start = new Date(now)
  if (windowType === 'minute') {
    start.setUTCSeconds(0, 0)
    return start
  }
  if (windowType === 'day') {
    start.setUTCHours(0, 0, 0, 0)
    return start
  }
  throw new TypeError('Email quota window must be minute or day.')
}

async function reserveWindow(
  QuotaModel,
  scopeKey,
  windowType,
  windowStart,
  limit,
) {
  const filter = { scopeKey, windowType, windowStart }
  try {
    await QuotaModel.updateOne(
      filter,
      { $setOnInsert: { ...filter, count: 0 } },
      { upsert: true },
    )
  } catch (error) {
    if (error?.code !== 11000) throw error
  }

  const updated = await QuotaModel.findOneAndUpdate(
    { ...filter, count: { $lt: limit } },
    { $inc: { count: 1 } },
    { new: true },
  ).lean()
  return updated ? { scopeKey, windowType, windowStart } : null
}

async function releaseReservations(QuotaModel, reservations) {
  for (const reservation of reservations) {
    await QuotaModel.updateOne(
      {
        ...reservation,
        count: { $gt: 0 },
      },
      { $inc: { count: -1 } },
    )
  }
}

export async function reserveEmailQuota({
  ownerId,
  policy,
  usage = 'submission',
  now = new Date(),
  QuotaModel = EmailQuota,
}) {
  if (usage !== 'submission' && usage !== 'execution') {
    throw new TypeError('Email quota usage must be submission or execution.')
  }
  const scopePrefix = usage === 'execution' ? 'send:' : ''
  const reservations = []
  const minuteStart = getQuotaWindowStart('minute', now)
  const dayStart = getQuotaWindowStart('day', now)
  const checks = [
    {
      scopeKey: `${scopePrefix}user:${String(ownerId)}`,
      windowType: 'minute',
      windowStart: minuteStart,
      limit: policy.perMinuteUserLimit,
      deniedCode: 'EMAIL_RATE_LIMITED',
    },
    {
      scopeKey: `${scopePrefix}user:${String(ownerId)}`,
      windowType: 'day',
      windowStart: dayStart,
      limit: policy.dailyUserQuota,
      deniedCode: 'EMAIL_DAILY_QUOTA_EXCEEDED',
    },
    {
      scopeKey: `${scopePrefix}global`,
      windowType: 'day',
      windowStart: dayStart,
      limit: policy.dailyGlobalQuota,
      deniedCode: 'EMAIL_GLOBAL_QUOTA_EXCEEDED',
    },
  ]

  for (const check of checks) {
    const reservation = await reserveWindow(
      QuotaModel,
      check.scopeKey,
      check.windowType,
      check.windowStart,
      check.limit,
    )
    if (!reservation) {
      await releaseReservations(
        QuotaModel,
        reservations.filter((entry) => entry.windowType === 'day'),
      )
      return { allowed: false, code: check.deniedCode }
    }
    reservations.push(reservation)
  }

  let released = false
  return {
    allowed: true,
    async release() {
      if (released) return
      released = true
      await releaseReservations(
        QuotaModel,
        reservations.filter((entry) => entry.windowType === 'day'),
      )
    },
  }
}
