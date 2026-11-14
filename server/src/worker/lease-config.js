function readPositiveInteger(name, defaultValue) {
  const configuredValue = process.env[name]
  if (configuredValue === undefined) {
    return defaultValue
  }
  if (!/^[1-9]\d*$/.test(configuredValue)) {
    throw new Error(`${name} must be a positive integer.`)
  }
  const value = Number(configuredValue)
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${name} must be a positive safe integer.`)
  }
  return value
}

export function getLeaseOptions() {
  const leaseDurationMs = readPositiveInteger('WORKER_LEASE_DURATION_MS', 30_000)
  const heartbeatIntervalMs = readPositiveInteger('WORKER_HEARTBEAT_INTERVAL_MS', 10_000)

  if (heartbeatIntervalMs >= leaseDurationMs) {
    throw new Error('WORKER_HEARTBEAT_INTERVAL_MS must be shorter than WORKER_LEASE_DURATION_MS.')
  }

  return { leaseDurationMs, heartbeatIntervalMs }
}
