import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createWorker } from './worker-runtime.js'

test('worker stop wakes an idle poll loop and resolves run()', async () => {
  let claims = 0
  const worker = createWorker({
    workerId: 'shutdown-test-worker',
    pollIntervalMs: 60_000,
    queue: {
      async claimNextJob() {
        claims += 1
        return null
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  const runPromise = worker.run()
  await new Promise((resolve) => setImmediate(resolve))
  worker.stop()
  await runPromise

  assert.equal(claims, 1)
})

test('worker polling resumes after a transient MongoDB error without losing work', async () => {
  let claims = 0
  let worker
  const errors = []
  worker = createWorker({
    workerId: 'temporary-db-outage-worker',
    pollIntervalMs: 1,
    queue: {
      async claimNextJob() {
        claims += 1
        if (claims === 1) throw new Error('injected MongoDB outage')
        worker.stop()
        return null
      },
    },
    logger: {
      info() {},
      warn() {},
      error: (...args) => errors.push(args),
    },
  })

  await worker.run()

  assert.equal(claims, 2)
  assert.ok(errors.some(([message]) => message === 'Worker polling failed.'))
  assert.doesNotMatch(JSON.stringify(errors), /injected MongoDB outage/)
})

test('worker shutdown waits for its current job and claims no further work', async () => {
  let releaseHandler
  let announceHandlerStarted
  let claims = 0
  let completions = 0
  const handlerStarted = new Promise((resolve) => {
    announceHandlerStarted = resolve
  })
  const worker = createWorker({
    workerId: 'active-shutdown-test-worker',
    pollIntervalMs: 1,
    queue: {
      async claimNextJob() {
        claims += 1
        if (claims > 1) {
          return null
        }
        return { _id: 'test-job', type: 'test', payload: {} }
      },
      async completeJob() {
        completions += 1
        return { _id: 'test-job' }
      },
      async failJob() {
        assert.fail('The successful test handler must not fail.')
      },
    },
    getHandler: () =>
      () =>
        new Promise((resolve) => {
          releaseHandler = resolve
          announceHandlerStarted()
        }),
    logger: { info() {}, warn() {}, error() {} },
  })

  const runPromise = worker.run()
  await handlerStarted
  worker.stop()
  assert.equal(completions, 0)
  releaseHandler({ ok: true })
  await runPromise

  assert.equal(completions, 1)
  assert.equal(claims, 1)
})

test('worker passes the real handler result to conditional completion persistence', async () => {
  const expectedResult = {
    type: 'email',
    provider: 'resend',
    status: 'accepted',
    providerMessageId: 'provider-message-id',
  }
  let completionArguments
  let handlerContext
  const claimedJob = {
    _id: '0123456789abcdef01234567',
    ownerId: 'abcdef0123456789abcdef01',
    type: 'send_email',
    payload: { to: 'learner@example.test' },
  }
  const worker = createWorker({
    workerId: 'result-persistence-worker',
    queue: {
      async claimNextJob() {
        return claimedJob
      },
      async completeJob(...args) {
        completionArguments = args
        return { ...claimedJob, status: 'completed' }
      },
    },
    getHandler: () => async (_payload, context) => {
      handlerContext = context
      return expectedResult
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  assert.equal(await worker.processNextJob(), true)
  assert.equal(handlerContext.job, claimedJob)
  assert.equal(completionArguments[0], claimedJob)
  assert.equal(completionArguments[1], 'result-persistence-worker')
  assert.equal(completionArguments[4], expectedResult)
})

test('worker logs safe execution duration on completion', async () => {
  const infoLogs = []
  let monotonicTime = 100
  const worker = createWorker({
    workerId: 'duration-worker',
    queue: {
      async claimNextJob() {
        return {
          _id: 'duration-job',
          type: 'test',
          payload: { sensitive: 'not logged' },
        }
      },
      async completeJob() {
        return { status: 'completed' }
      },
    },
    getHandler: () => async () => {
      monotonicTime += 17.4
      return { ok: true }
    },
    logger: {
      info: (...args) => infoLogs.push(args),
      warn() {},
      error() {},
    },
    monotonicNow: () => monotonicTime,
  })

  await worker.processNextJob()
  const completion = infoLogs.find(([message]) => message === 'Job completed.')
  assert.equal(completion[1].executionDurationMs, 17)
  assert.doesNotMatch(JSON.stringify(infoLogs), /sensitive|not logged/)
})

test('worker rejects invalid polling intervals', () => {
  assert.throws(
    () => createWorker({ pollIntervalMs: 0 }),
    /pollIntervalMs must be a positive integer/,
  )
})

test('completion persistence errors do not run the handler failure retry path', async () => {
  let failureUpdates = 0
  const worker = createWorker({
    workerId: 'completion-error-worker',
    queue: {
      async claimNextJob() {
        return { _id: 'completed-handler-job', type: 'test', payload: {} }
      },
      async completeJob() {
        throw new Error('database unavailable')
      },
      async failJob() {
        failureUpdates += 1
      },
    },
    getHandler: () => async () => ({ ok: true }),
    logger: { info() {}, warn() {}, error() {} },
  })

  assert.equal(await worker.processNextJob(), true)
  assert.equal(failureUpdates, 0)
})

test('worker clears its scheduled heartbeat after handler execution', async () => {
  const timers = new Map()
  let nextTimerId = 0
  let clearedTimers = 0
  let renewals = 0
  const worker = createWorker({
    workerId: 'heartbeat-cleanup-worker',
    heartbeatIntervalMs: 10,
    leaseDurationMs: 100,
    queue: {
      async claimNextJob() {
        return {
          _id: 'heartbeat-job',
          type: 'test',
          payload: {},
          claimToken: 'claim-token',
        }
      },
      async renewLease() {
        renewals += 1
        return { leaseExpiresAt: new Date() }
      },
      async completeJob() {
        return { _id: 'heartbeat-job' }
      },
    },
    getHandler: () => async () => ({ ok: true }),
    logger: { info() {}, warn() {}, error() {} },
    setTimeoutFn(callback) {
      const id = ++nextTimerId
      timers.set(id, callback)
      return id
    },
    clearTimeoutFn(id) {
      if (timers.delete(id)) {
        clearedTimers += 1
      }
    },
  })

  assert.equal(await worker.processNextJob(), true)
  assert.equal(timers.size, 0)
  assert.equal(clearedTimers, 1)
  assert.equal(renewals, 0)
})

test('worker does not persist success after heartbeat reports lost ownership', async () => {
  let heartbeatCallback
  let announceRenewal
  let completeUpdates = 0
  let releaseHandler
  const renewalStarted = new Promise((resolve) => {
    announceRenewal = resolve
  })
  const handlerStarted = new Promise((resolve) => {
    releaseHandler = resolve
  })
  const worker = createWorker({
    workerId: 'lost-lease-worker',
    heartbeatIntervalMs: 1,
    leaseDurationMs: 100,
    queue: {
      async claimNextJob() {
        return {
          _id: 'lost-lease-job',
          type: 'test',
          payload: {},
          claimToken: 'claim-token',
        }
      },
      async renewLease() {
        announceRenewal()
        return null
      },
      async completeJob() {
        completeUpdates += 1
        return { _id: 'lost-lease-job' }
      },
      async failJob() {
        assert.fail('Lost ownership must not persist a failure.')
      },
    },
    getHandler: () => async () => {
      await handlerStarted
      return { ok: true }
    },
    logger: { info() {}, warn() {}, error() {} },
    setTimeoutFn(callback) {
      heartbeatCallback = callback
      return 1
    },
    clearTimeoutFn() {},
  })

  const processing = worker.processNextJob()
  await new Promise((resolve) => setImmediate(resolve))
  heartbeatCallback()
  await renewalStarted
  releaseHandler()
  assert.equal(await processing, true)
  assert.equal(completeUpdates, 0)
})

test('worker does not persist after heartbeat renewal fails temporarily', async () => {
  let heartbeatCallback
  let announceRenewalFailure
  let releaseHandler
  let completionUpdates = 0
  const renewalFailed = new Promise((resolve) => {
    announceRenewalFailure = resolve
  })
  const handlerStarted = new Promise((resolve) => {
    releaseHandler = resolve
  })
  const errors = []
  const worker = createWorker({
    workerId: 'heartbeat-outage-worker',
    heartbeatIntervalMs: 1,
    leaseDurationMs: 100,
    queue: {
      async claimNextJob() {
        return {
          _id: 'heartbeat-outage-job',
          type: 'test',
          payload: {},
          claimToken: 'claim-token',
        }
      },
      async renewLease() {
        announceRenewalFailure()
        throw new Error('injected MongoDB outage')
      },
      async completeJob() {
        completionUpdates += 1
      },
    },
    getHandler: () => async () => {
      await handlerStarted
      return { ok: true }
    },
    logger: {
      info() {},
      warn() {},
      error: (...args) => errors.push(args),
    },
    setTimeoutFn(callback) {
      heartbeatCallback = callback
      return 1
    },
    clearTimeoutFn() {},
  })

  const processing = worker.processNextJob()
  await new Promise((resolve) => setImmediate(resolve))
  heartbeatCallback()
  await renewalFailed
  await new Promise((resolve) => setImmediate(resolve))
  releaseHandler()

  assert.equal(await processing, true)
  assert.equal(completionUpdates, 0)
  assert.ok(errors.some(([message]) => message === 'Worker heartbeat failed; result will not be persisted.'))
  assert.doesNotMatch(JSON.stringify(errors), /injected MongoDB outage/)
})

test('worker requires heartbeat interval to be shorter than lease duration', () => {
  assert.throws(
    () => createWorker({ leaseDurationMs: 100, heartbeatIntervalMs: 100 }),
    /heartbeatIntervalMs must be positive and shorter/,
  )
})

test('worker provides reportProgress and passes attemptInfo on completion and failure', async () => {
  let progressReported = null
  let completionAttemptInfo = null
  let failureAttemptInfo = null

  // 1. Successful execution with progress
  const successWorker = createWorker({
    workerId: 'worker-progress-1',
    pollIntervalMs: 1000,
    queue: {
      async claimNextJob() {
        return { _id: 'job-progress', type: 'progress_type', payload: {}, attempts: 0 }
      },
      async updateJobProgress(job, workerId, progressData) {
        progressReported = { ...progressData, workerId }
      },
      async completeJob(job, workerId, completedAt, eventPublisher, result, options) {
        completionAttemptInfo = options?.attemptInfo
        return { ...job, status: 'completed' }
      },
    },
    getHandler: () => async (payload, context) => {
      await context.reportProgress({ percent: 50, stage: 'halfway', message: 'In progress' })
      return { success: true }
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  await successWorker.processNextJob()
  assert.deepEqual(progressReported, {
    percent: 50,
    stage: 'halfway',
    message: 'In progress',
    workerId: 'worker-progress-1',
  })
  assert.ok(completionAttemptInfo)
  assert.equal(completionAttemptInfo.attempt, 1)
  assert.equal(completionAttemptInfo.workerId, 'worker-progress-1')
  assert.equal(completionAttemptInfo.error, undefined)

  // 2. Failed execution with attemptInfo
  const failWorker = createWorker({
    workerId: 'worker-fail-1',
    pollIntervalMs: 1000,
    queue: {
      async claimNextJob() {
        return { _id: 'job-fail', type: 'fail_type', payload: {}, attempts: 1 }
      },
      async failJob(job, workerId, error, options) {
        failureAttemptInfo = options?.attemptInfo
        return { ...job, status: 'failed', attempts: 2 }
      },
    },
    getHandler: () => async () => {
      const err = new Error('Test handler explosion')
      err.name = 'TestHandlerError'
      throw err
    },
    logger: { info() {}, warn() {}, error() {} },
  })

  await failWorker.processNextJob()
  assert.ok(failureAttemptInfo)
  assert.equal(failureAttemptInfo.attempt, 2)
  assert.equal(failureAttemptInfo.workerId, 'worker-fail-1')
  assert.equal(failureAttemptInfo.error, 'TestHandlerError')
})
