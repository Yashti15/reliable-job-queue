import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getRetryOptions } from './retry-config.js'

test('retry configuration uses safe defaults', () => {
  assert.deepEqual(getRetryOptions({}), {
    baseDelayMs: 2000,
    maxRetryDelayMs: 60_000,
    jitterRatio: 0.2,
  })
})

test('retry configuration parses explicit values', () => {
  assert.deepEqual(
    getRetryOptions({
      BASE_DELAY_MS: '1500',
      MAX_RETRY_DELAY_MS: '12000',
      RETRY_JITTER_RATIO: '0.1',
    }),
    {
      baseDelayMs: 1500,
      maxRetryDelayMs: 12000,
      jitterRatio: 0.1,
    },
  )
})

test('retry configuration rejects invalid values', () => {
  assert.throws(
    () => getRetryOptions({ BASE_DELAY_MS: '0' }),
    /BASE_DELAY_MS must be a positive integer/,
  )
  assert.throws(
    () => getRetryOptions({ MAX_RETRY_DELAY_MS: 'not-a-number' }),
    /MAX_RETRY_DELAY_MS must be a positive integer/,
  )
  assert.throws(
    () => getRetryOptions({ RETRY_JITTER_RATIO: '1.1' }),
    /RETRY_JITTER_RATIO must be a number between 0 and 1/,
  )
})
