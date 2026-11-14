import dotenv from 'dotenv'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import mongoose from 'mongoose'
import app from './app.js'
import { connectDatabase } from './config/db.js'
import { createSocketServer } from './realtime/socket-server.js'
import { validateAuthConfiguration } from './auth/session.js'

dotenv.config({ path: fileURLToPath(new URL('../.env', import.meta.url)) })

const port = Number(process.env.PORT) || 5000

async function startServer() {
  validateAuthConfiguration()
  await connectDatabase()

  const httpServer = createServer(app)
  const { io, bridge } = createSocketServer(httpServer)
  await bridge.ready

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(port, resolve)
  })
  console.log(`API and Socket.IO listening on port ${port}.`)

  let shuttingDown = false
  async function shutdown(signal) {
    if (shuttingDown) return
    shuttingDown = true
    console.log(`API received ${signal}; shutting down.`)
    await bridge.stop()
    await new Promise((resolve) => io.close(resolve))
    await mongoose.disconnect()
    console.log('API shutdown complete.')
  }

  process.once('SIGINT', () => void shutdown('SIGINT'))
  process.once('SIGTERM', () => void shutdown('SIGTERM'))

}

startServer().catch((error) => {
  console.error('Unable to start the API:', error)
  process.exitCode = 1
})
