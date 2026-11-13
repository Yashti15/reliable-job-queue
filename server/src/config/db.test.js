import assert from 'node:assert/strict'
import { test } from 'node:test'
import { connectDatabase } from './db.js'

test('connectDatabase rejects when MONGODB_URI is missing', async () => {
  const originalUri = process.env.MONGODB_URI
  delete process.env.MONGODB_URI

  try {
    await assert.rejects(
      connectDatabase(),
      /MONGODB_URI is missing\. Add the Atlas connection string to server\/\.env\./,
    )
  } finally {
    if (originalUri === undefined) {
      delete process.env.MONGODB_URI
    } else {
      process.env.MONGODB_URI = originalUri
    }
  }
})

test('connectDatabase reports invalid MongoDB URI without exposing its value', async () => {
  const originalUri = process.env.MONGODB_URI
  const invalidUri = 'not-a-mongodb-uri-secret-placeholder'
  process.env.MONGODB_URI = invalidUri

  try {
    await assert.rejects(connectDatabase(), (error) => {
      assert.match(error.message, /MongoDB connection failed/)
      assert.doesNotMatch(error.message, new RegExp(invalidUri))
      return true
    })
  } finally {
    if (originalUri === undefined) {
      delete process.env.MONGODB_URI
    } else {
      process.env.MONGODB_URI = originalUri
    }
  }
})
