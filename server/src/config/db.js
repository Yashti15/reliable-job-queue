import mongoose from 'mongoose'

const connectionStates = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
}

export async function connectDatabase(options = {}) {
  const uri = process.env.MONGODB_URI?.trim()

  if (!uri) {
    throw new Error('MONGODB_URI is missing. Add the Atlas connection string to server/.env.')
  }

  try {
    await mongoose.connect(uri, options)
  } catch (error) {
    const reason = error instanceof Error ? error.name : 'UnknownError'
    throw new Error(
      `MongoDB connection failed (${reason}). Check the URI format, database user credentials, and Atlas Network Access/IP allowlist.`,
    )
  }

  console.log('Connected to MongoDB.')
}

export function getDatabaseStatus() {
  if (!process.env.MONGODB_URI?.trim()) {
    return 'not_configured'
  }

  return connectionStates[mongoose.connection.readyState] ?? 'unknown'
}
