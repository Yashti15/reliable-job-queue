import assert from 'node:assert/strict'
import { test } from 'node:test'
import { calculateRetryDelay } from './retry-policy.js'

test('exponential delay doubles for each failed attempt', () => {
  const options = {
    baseDelayMs: 2000,
    maxRetryDelayMs: 60_000,
    jitterRatio: 0,
    random: () => 0,
  }

  assert.equal(calculateRetryDelay(1, options), 2000)
  assert.equal(calculateRetryDelay(2, options), 4000)
  assert.equal(calculateRetryDelay(3, options), 8000)
})

test('positive jitter stays within its configured bound', () => {
  const options = {
    baseDelayMs: 2000,
    maxRetryDelayMs: 60_000,
    jitterRatio: 0.25,
  }

  assert.equal(calculateRetryDelay(1, { ...options, random: () => 0 }), 2000)
  assert.equal(calculateRetryDelay(1, { ...options, random: () => 0.999999 }), 2500)
  assert.equal(calculateRetryDelay(2, { ...options, random: () => 0.999999 }), 5000)
})

test('retry delay never exceeds the configured maximum', () => {
  assert.equal(
    calculateRetryDelay(4, {
      baseDelayMs: 2000,
      maxRetryDelayMs: 9000,
      jitterRatio: 1,
      random: () => 0.999999,
    }),
    9000,
  )
  assert.equal(
    calculateRetryDelay(20, {
      baseDelayMs: 2000,
      maxRetryDelayMs: 9000,
      jitterRatio: 0.5,
      random: () => 0.999999,
    }),
    9000,
  )
})

test('retry policy validates attempts, limits, jitter, and injected randomness', () => {
  assert.throws(() => calculateRetryDelay(0), /attempts must be a positive/)
  assert.throws(
    () => calculateRetryDelay(1, { baseDelayMs: 0 }),
    /baseDelayMs must be a positive/,
  )
  assert.throws(
    () => calculateRetryDelay(1, { jitterRatio: 2 }),
    /jitterRatio must be between 0 and 1/,
  )
  assert.throws(
    () => calculateRetryDelay(1, { random: () => -0.1 }),
    /random must return a number between 0 and 1/,
  )
  assert.throws(
    () => calculateRetryDelay(1, { random: () => 1 }),
    /random must return a number between 0 and 1/,
  )
})
