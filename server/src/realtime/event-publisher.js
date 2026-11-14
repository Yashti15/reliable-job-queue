import QueueEvent from '../models/queue-event.model.js'

const safeJobFields = [
  '_id',
  'type',
  'status',
  'priority',
  'attempts',
  'maxAttempts',
  'runAt',
  'createdAt',
  'updatedAt',
  'workerId',
  'deadAt',
  'replayCount',
  'completedAt',
]

function safeErrorName(error) {
  const name = error instanceof Error ? error.name : ''
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'UnknownError'
}

export function sanitizeJobEvent(job) {
  const data = {}
  for (const field of safeJobFields) {
    if (job?.[field] !== undefined && job[field] !== null) {
      data[field === '_id' ? 'jobId' : field] =
        field === '_id' ? String(job[field]) : job[field]
    }
  }
  return data
}

export function createEventPublisher({ EventModel = QueueEvent, logger = console } = {}) {
  return async function publishEvent(name, data, ownerId) {
    try {
      if (!ownerId) {
        logger.error('Queue event publication skipped (missing owner).')
        return false
      }
      await EventModel.create({ name, data, ownerId })
      return true
    } catch (error) {
      logger.error(`Queue event publication failed (${safeErrorName(error)}).`)
      return false
    }
  }
}

export const publishEvent = createEventPublisher()

export function publishJobEvent(
  name,
  job,
  publisher = publishEvent,
  ownerId = job?.ownerId,
) {
  return publisher(name, sanitizeJobEvent(job), ownerId)
}
