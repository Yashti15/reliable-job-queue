const defaultRetryOptions = {
  baseDelayMs: 2000,
  maxRetryDelayMs: 60_000,
  jitterRatio: 0.2,
}

function assertPositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer.`)
  }
}

export function calculateRetryDelay(
  attempts,
  {
    baseDelayMs = defaultRetryOptions.baseDelayMs,
    maxRetryDelayMs = defaultRetryOptions.maxRetryDelayMs,
    jitterRatio = defaultRetryOptions.jitterRatio,
    random = Math.random,
  } = {},
) {
  assertPositiveInteger(attempts, 'attempts')
  assertPositiveInteger(baseDelayMs, 'baseDelayMs')
  assertPositiveInteger(maxRetryDelayMs, 'maxRetryDelayMs')

  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new RangeError('jitterRatio must be between 0 and 1.')
  }
  if (typeof random !== 'function') {
    throw new TypeError('random must be a function.')
  }

  const randomValue = random()
  if (!Number.isFinite(randomValue) || randomValue < 0 || randomValue >= 1) {
    throw new RangeError('random must return a number between 0 and 1 (excluding 1).')
  }

  const exponentialDelay = Math.min(
    maxRetryDelayMs,
    baseDelayMs * 2 ** (attempts - 1),
  )
  const availableDelay = maxRetryDelayMs - exponentialDelay
  const maxJitterMs = Math.min(
    Math.floor(exponentialDelay * jitterRatio),
    availableDelay,
  )
  const jitterMs = Math.floor(randomValue * (maxJitterMs + 1))

  return exponentialDelay + jitterMs
}

export { defaultRetryOptions }
