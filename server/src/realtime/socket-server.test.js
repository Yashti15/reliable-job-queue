import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { test } from 'node:test'
import { io as createSocketClient } from 'socket.io-client'
import { createSocketServer, startEventBridge } from './socket-server.js'

function createEventModel() {
  const events = []
  return {
    events,
    findOne() {
      const query = {
        sort() {
          return query
        },
        select() {
          return query
        },
        async lean() {
          return events.at(-1) ?? null
        },
      }
      return query
    },
    find(filter = {}) {
      const query = {
        batchSize: 0,
        sort() {
          return query
        },
        limit(size) {
          query.batchSize = size
          return query
        },
        async lean() {
          const cursor = filter._id?.$gt ?? 0
          return events
            .filter((event) => event._id > cursor)
            .slice(0, query.batchSize)
        },
      }
      return query
    },
  }
}

test('event bridge emits newly persisted records and stops polling cleanly', { timeout: 5000 }, async () => {
  const model = createEventModel()
  const emitted = []
  const io = {
    to: (room) => ({
      emit: (name, data) => emitted.push({ room, name, data }),
    }),
  }
  const bridge = startEventBridge(io, {
    EventModel: model,
    pollingIntervalMs: 5,
    batchSize: 2,
    logger: { error: assert.fail },
  })
  await bridge.ready

  model.events.push({
    _id: 1,
    ownerId: 'user-a',
    name: 'job:created',
    data: { jobId: 'job-1' },
  })
  for (let attempt = 0; attempt < 30 && emitted.length === 0; attempt += 1) {
    await delay(5)
  }
  await bridge.stop()

  assert.deepEqual(emitted, [
    { room: 'user:user-a', name: 'job:created', data: { jobId: 'job-1' } },
  ])
})

test('Socket.IO authenticates clients and isolates events in server-controlled user rooms', { timeout: 10_000 }, async (context) => {
  const model = createEventModel()
  const httpServer = createServer()
  const { io, bridge } = createSocketServer(httpServer, {
    EventModel: model,
    resolveUser: async (token) =>
      token === 'user-a' || token === 'user-b'
        ? { userId: token, expiresAt: Date.now() + 60_000 }
        : null,
    logger: { info() {}, error: assert.fail },
  })
  await bridge.ready
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`
  const serverSockets = new Map()
  io.on('connection', (socket) => serverSockets.set(socket.data.userId, socket))
  const clientA = createSocketClient(url, {
    extraHeaders: { Cookie: 'rq_session=user-a' },
    reconnection: false,
    timeout: 3000,
  })
  const clientB = createSocketClient(url, {
    extraHeaders: { Cookie: 'rq_session=user-b' },
    reconnection: false,
    timeout: 3000,
  })
  const rejectedClient = createSocketClient(url, { reconnection: false, timeout: 3000 })
  context.after(async () => {
    clientA.disconnect()
    clientB.disconnect()
    rejectedClient.disconnect()
    await bridge.stop()
    await new Promise((resolve) => io.close(resolve))
  })

  await Promise.all([
    once(clientA, 'connect', { signal: AbortSignal.timeout(4000) }),
    once(clientB, 'connect', { signal: AbortSignal.timeout(4000) }),
  ])
  const failedHandshake = once(rejectedClient, 'connect_error', { signal: AbortSignal.timeout(4000) })
  assert.match((await failedHandshake)[0].message, /Authentication required/)

  clientA.emit('join', 'user:user-b')
  const fromA = once(clientA, 'job:created')
  const fromB = once(clientB, 'job:created')
  model.events.push({
    _id: 1,
    ownerId: 'user-a',
    name: 'job:created',
    data: { jobId: 'job-a' },
  })
  assert.deepEqual((await fromA)[0], { jobId: 'job-a' })
  const noLeakToB = Promise.race([
    once(clientB, 'job:created').then(() => false),
    delay(50).then(() => true),
  ])
  assert.equal(await noLeakToB, true)

  const fromBRoom = once(clientB, 'job:completed')
  const noLeakToA = Promise.race([
    once(clientA, 'job:completed').then(() => false),
    delay(50).then(() => true),
  ])
  model.events.push({
    _id: 2,
    ownerId: 'user-b',
    name: 'job:completed',
    data: { jobId: 'job-b' },
  })
  assert.equal(await noLeakToA, true)
  assert.deepEqual((await fromBRoom)[0], { jobId: 'job-b' })

  const disconnected = once(serverSockets.get('user-a'), 'disconnect')
  clientA.disconnect()
  await disconnected
  assert.equal(clientA.connected, false)
})

test('Socket.IO authenticates via auth handshake token, rejects invalid/expired tickets, and reconnects', { timeout: 10_000 }, async (context) => {
  const model = createEventModel()
  const httpServer = createServer()
  let ticketVersion = 1
  const { io, bridge } = createSocketServer(httpServer, {
    EventModel: model,
    resolveUser: async (token) => {
      if (token === 'valid-ticket' || token === 'reconnect-ticket') {
        return { userId: 'user-token-owner', expiresAt: Date.now() + 60_000 }
      }
      if (token === 'expired-ticket') {
        const err = new Error('jwt expired')
        err.name = 'TokenExpiredError'
        throw err
      }
      if (token === 'invalid-ticket') {
        const err = new Error('invalid signature')
        err.name = 'JsonWebTokenError'
        throw err
      }
      return null
    },
    logger: { info() {}, error() {} },
  })
  await bridge.ready
  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${httpServer.address().port}`

  // 1. Valid auth token
  const validClient = createSocketClient(url, {
    auth: { token: 'valid-ticket' },
    reconnection: false,
    timeout: 3000,
  })

  // 2. Expired auth token
  const expiredClient = createSocketClient(url, {
    auth: { token: 'expired-ticket' },
    reconnection: false,
    timeout: 3000,
  })

  // 3. Invalid auth token
  const invalidClient = createSocketClient(url, {
    auth: { token: 'invalid-ticket' },
    reconnection: false,
    timeout: 3000,
  })

  // 4. Missing auth token and cookie
  const emptyClient = createSocketClient(url, {
    auth: {},
    reconnection: false,
    timeout: 3000,
  })

  // 5. Dynamic reconnection client
  let activeToken = 'valid-ticket'
  const reconnectClient = createSocketClient(url, {
    auth: (cb) => cb({ token: activeToken }),
    reconnection: true,
    reconnectionDelay: 50,
    timeout: 3000,
  })

  context.after(async () => {
    validClient.disconnect()
    expiredClient.disconnect()
    invalidClient.disconnect()
    emptyClient.disconnect()
    reconnectClient.disconnect()
    await bridge.stop()
    await new Promise((resolve) => io.close(resolve))
  })

  await once(validClient, 'connect', { signal: AbortSignal.timeout(4000) })
  assert.equal(validClient.connected, true, 'Valid auth ticket must connect successfully')

  const expiredError = once(expiredClient, 'connect_error', { signal: AbortSignal.timeout(4000) })
  assert.match((await expiredError)[0].message, /Authentication required/)

  const invalidError = once(invalidClient, 'connect_error', { signal: AbortSignal.timeout(4000) })
  assert.match((await invalidError)[0].message, /Authentication required/)

  const emptyError = once(emptyClient, 'connect_error', { signal: AbortSignal.timeout(4000) })
  assert.match((await emptyError)[0].message, /Authentication required/)

  await once(reconnectClient, 'connect', { signal: AbortSignal.timeout(4000) })
  assert.equal(reconnectClient.connected, true)

  // Simulate ticket refresh upon reconnect
  activeToken = 'reconnect-ticket'
  reconnectClient.io.engine.close()
  await once(reconnectClient, 'connect', { signal: AbortSignal.timeout(4000) })
  assert.equal(reconnectClient.connected, true, 'Client must reconnect using updated ticket from auth callback')
})
