import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { startWorkerMonitor } from './worker-monitor.js'

test('worker heartbeat updates last-seen and graceful stop is recorded', async () => {
  let timestamp = new Date('2025-03-01T12:00:00.000Z')
  let workerRecord
  const events = []
  const WorkerModel = {
    findOneAndUpdate(_filter, update) {
      workerRecord = { ...workerRecord, ...update.$set }
      for (const field of Object.keys(update.$unset ?? {})) delete workerRecord[field]
      const result = { ...workerRecord }
      return {
        then(resolve, reject) {
          return Promise.resolve(result).then(resolve, reject)
        },
        async lean() {
          return result
        },
      }
    },
    async updateOne(_filter, update) {
      Object.assign(workerRecord, update.$set)
      for (const field of Object.keys(update.$unset ?? {})) delete workerRecord[field]
      return { matchedCount: 1 }
    },
  }
  const firstOwnerId = new mongoose.Types.ObjectId()
  const secondOwnerId = new mongoose.Types.ObjectId()
  const monitor = await startWorkerMonitor({
    workerId: 'monitor-test',
    heartbeatIntervalMs: 5,
    WorkerModel,
    now: () => {
      timestamp = new Date(timestamp.getTime() + 10)
      return timestamp
    },
    publish: async (name, data, ownerId) => events.push({ name, data, ownerId }),
    logger: { error: assert.fail },
  })

  await monitor.setCurrentJob({
    _id: 'job-1',
    type: 'send_email',
    ownerId: firstOwnerId,
  })
  await monitor.setCurrentJob(null)
  await monitor.setCurrentJob({
    _id: 'job-2',
    type: 'send_email',
    ownerId: secondOwnerId,
  })
  const activeRecord = { ...workerRecord }
  await delay(20)
  await monitor.stop()

  assert.ok(events.some((event) => event.name === 'worker:heartbeat'))
  assert.ok(events.some((event) => event.ownerId.equals(firstOwnerId)))
  assert.ok(events.some((event) => event.ownerId.equals(secondOwnerId)))
  assert.ok(workerRecord.lastSeenAt > workerRecord.startedAt)
  assert.equal(activeRecord.currentJobOwnerId.toString(), secondOwnerId.toString())
  assert.equal(activeRecord.currentJobId, 'job-2')
  assert.equal(workerRecord.currentJobOwnerId.toString(), secondOwnerId.toString())
  assert.equal(workerRecord.status, 'stopped')
  assert.ok(workerRecord.stoppedAt instanceof Date)
  assert.ok(!workerRecord.currentJobId)
})
