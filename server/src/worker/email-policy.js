const emailAddressPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const emailDomainPattern =
  /^@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i

function parsePositiveInteger(value, defaultValue) {
  if (value === undefined || value === '') return defaultValue
  if (!/^[1-9]\d*$/.test(value)) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

export function getEmailPolicy(environment = process.env) {
  const disabled = environment.EMAIL_SENDING_ENABLED !== 'true'
  if (disabled) {
    return {
      enabled: false,
      configured: false,
      allowedRecipients: [],
      configurationMessage:
        'Shared-provider email sending is disabled. Explicitly enable it with a recipient allowlist.',
    }
  }

  const allowedRecipients = (environment.EMAIL_ALLOWED_RECIPIENTS ?? '')
    .split(',')
    .map((recipient) => recipient.trim().toLowerCase())
    .filter(Boolean)
  const hasInvalidRecipient = allowedRecipients.some(
    (recipient) =>
      !emailAddressPattern.test(recipient) && !emailDomainPattern.test(recipient),
  )
  const settings = {
    dailyUserQuota: parsePositiveInteger(
      environment.EMAIL_DAILY_QUOTA_PER_USER,
      5,
    ),
    dailyGlobalQuota: parsePositiveInteger(
      environment.EMAIL_DAILY_QUOTA_GLOBAL,
      100,
    ),
    perMinuteUserLimit: parsePositiveInteger(
      environment.EMAIL_JOBS_PER_MINUTE,
      3,
    ),
  }

  const configured =
    allowedRecipients.length > 0 &&
    !hasInvalidRecipient &&
    Object.values(settings).every((value) => value !== null)
  return {
    enabled: configured,
    configured,
    allowedRecipients,
    ...settings,
    configurationMessage: configured
      ? undefined
      : 'Email policy configuration is invalid; sending remains disabled.',
  }
}

export function isAllowedEmailRecipient(recipient, allowedRecipients) {
  if (typeof recipient !== 'string' || !Array.isArray(allowedRecipients)) {
    return false
  }
  const normalized = recipient.trim().toLowerCase()
  const separator = normalized.lastIndexOf('@')
  if (separator <= 0) return false
  const domain = normalized.slice(separator)

  return allowedRecipients.some((allowed) =>
    allowed.startsWith('@')
      ? domain === allowed
      : normalized === allowed,
  )
}
