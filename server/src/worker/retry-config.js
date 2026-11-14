const defaults = {
  baseDelayMs: 2000,
  maxRetryDelayMs: 60_000,
  jitterRatio: 0.2,
}

function parsePositiveInteger(value, name, fallback) {
  if (value === undefined) {
    return fallback
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${name} must be a positive safe integer.`)
  }
  return parsed
}

function parseJitterRatio(value) {
  if (value === undefined) {
    return defaults.jitterRatio
  }

  const ratio = Number(value)
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('RETRY_JITTER_RATIO must be a number between 0 and 1.')
  }
  return ratio
}

export function getRetryOptions(environment = process.env) {
  return {
    baseDelayMs: parsePositiveInteger(
      environment.BASE_DELAY_MS,
      'BASE_DELAY_MS',
      defaults.baseDelayMs,
    ),
    maxRetryDelayMs: parsePositiveInteger(
      environment.MAX_RETRY_DELAY_MS,
      'MAX_RETRY_DELAY_MS',
      defaults.maxRetryDelayMs,
    ),
    jitterRatio: parseJitterRatio(environment.RETRY_JITTER_RATIO),
  }
}
