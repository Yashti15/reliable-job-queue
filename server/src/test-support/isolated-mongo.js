import { randomUUID } from 'node:crypto'
import mongoose from 'mongoose'

const localHosts = new Set(['127.0.0.1', 'localhost', '[::1]'])

export async function connectToIsolatedMongoTestDatabase() {
  const uri = process.env.MONGODB_TEST_URI
  if (!uri) {
    throw new Error('MONGODB_TEST_URI is required to run MongoDB integration tests.')
  }

  const parsedUri = new URL(uri)
  if (
    parsedUri.protocol !== 'mongodb:' ||
    !localHosts.has(parsedUri.hostname.toLowerCase())
  ) {
    throw new Error('MongoDB integration tests are allowed only on local MongoDB.')
  }

  const baseDatabaseName = decodeURIComponent(parsedUri.pathname.slice(1))
  if (!/_test$/i.test(baseDatabaseName)) {
    throw new Error('MONGODB_TEST_URI database name must end with "_test".')
  }

  const databaseName = `${baseDatabaseName}_${process.pid}_${randomUUID()
    .replaceAll('-', '')
    .slice(0, 12)}`
  await mongoose.connect(uri, {
    dbName: databaseName,
    serverSelectionTimeoutMS: 5000,
  })

  if (mongoose.connection.name !== databaseName) {
    await mongoose.disconnect()
    throw new Error('MongoDB test database isolation could not be verified.')
  }

  await mongoose.connection.dropDatabase()

  return async function closeIsolatedMongoTestDatabase() {
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
}
