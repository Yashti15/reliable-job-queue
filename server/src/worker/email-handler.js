import { randomUUID } from 'node:crypto'
import { JobHandlerError } from '../errors/job-handler-error.js'
import { validateEmailPayload } from './job-payloads.js'
import { getEmailPolicy, isAllowedEmailRecipient } from './email-policy.js'
import { reserveEmailQuota } from './email-quota.js'

const resendEndpoint = 'https://api.resend.com/emails'
const defaultTimeoutMs = 10_000

export function createEmailHandler({
  fetchImpl = globalThis.fetch,
  getConfig = () => {
    const timeoutValue = process.env.EMAIL_PROVIDER_TIMEOUT_MS
    return {
      apiKey: process.env.RESEND_API_KEY?.trim(),
      from: process.env.EMAIL_FROM?.trim(),
      timeoutMs:
        timeoutValue === undefined ? defaultTimeoutMs : Number(timeoutValue),
    }
  },
  getPolicy = () => getEmailPolicy(),
  reserveQuota = reserveEmailQuota,
  endpoint = resendEndpoint,
} = {}) {
  return async function sendEmail(payload, { job } = {}) {
    const message = validateEmailPayload(payload)
    const policy = getPolicy()
    if (!policy.enabled) {
      throw new JobHandlerError(
        policy.configurationMessage ??
          'Email delivery is disabled or not safely configured.',
        { name: 'EmailConfigurationError' },
      )
    }
    if (!isAllowedEmailRecipient(message.to, policy.allowedRecipients)) {
      throw new JobHandlerError('Recipient is not permitted by the email allowlist.', {
        name: 'EmailRecipientNotAllowedError',
      })
    }

    const jobId = String(job?._id ?? '')
    const ownerId = String(job?.ownerId ?? '')
    if (!/^[0-9a-f]{24}$/i.test(jobId) || !/^[0-9a-f]{24}$/i.test(ownerId)) {
      throw new JobHandlerError('Email job ownership context is missing.', {
        name: 'JobExecutionContextError',
      })
    }

    // In demo mode: strictly mock provider delivery; NEVER send unsolicited real emails
    if (policy.isDemoMode || process.env.EMAIL_DEMO_MODE === 'true') {
      return {
        type: 'email',
        provider: 'resend',
        status: 'accepted',
        providerMessageId: `demo_${randomUUID()}`,
      }
    }

    const config = getConfig()
    if (!config.apiKey || !isValidSender(config.from)) {
      throw new JobHandlerError(
        'Email delivery is not configured. Set RESEND_API_KEY and a valid EMAIL_FROM address.',
        { name: 'EmailConfigurationError' },
      )
    }
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 100) {
      throw new JobHandlerError('Email provider timeout configuration is invalid.', {
        name: 'EmailConfigurationError',
      })
    }

    let quota
    try {
      quota = await reserveQuota({
        ownerId,
        policy,
        usage: 'execution',
      })
    } catch {
      throw new JobHandlerError('Email sending capacity could not be verified.', {
        name: 'EmailQuotaUnavailableError',
      })
    }
    if (!quota.allowed) {
      throw new JobHandlerError('Configured email sending quota has been reached.', {
        name: 'EmailQuotaExceededError',
      })
    }
    const replayCount = Number.isSafeInteger(job?.replayCount) ? job.replayCount : 0
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs)

    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `rq-${jobId}-${replayCount}`,
        },
        body: JSON.stringify({ from: config.from, ...message }),
        signal: controller.signal,
      })

      if (response.status === 429 || response.status >= 500) {
        throw new JobHandlerError('Email provider is temporarily unavailable; the job can be retried.', {
          name: 'EmailProviderUnavailableError',
        })
      }
      if (!response.ok) {
        throw new JobHandlerError('Email provider rejected the request.', {
          name: 'EmailProviderRejectedError',
        })
      }

      let providerMessageId
      try {
        const body = await response.json()
        if (typeof body?.id === 'string' && body.id.length <= 200) {
          providerMessageId = body.id
        }
      } catch {
        throw new JobHandlerError('Email provider returned an invalid response.', {
          name: 'EmailProviderResponseError',
        })
      }
      if (!providerMessageId) {
        throw new JobHandlerError('Email provider returned an invalid response.', {
          name: 'EmailProviderResponseError',
        })
      }

      return {
        type: 'email',
        provider: 'resend',
        status: 'accepted',
        providerMessageId,
      }
    } catch (error) {
      if (error instanceof JobHandlerError) throw error
      if (controller.signal.aborted) {
        throw new JobHandlerError('Email provider request timed out; the job can be retried.', {
          name: 'EmailProviderTimeoutError',
        })
      }
      throw new JobHandlerError('Email provider could not be reached; the job can be retried.', {
        name: 'EmailProviderNetworkError',
      })
    } finally {
      clearTimeout(timeout)
    }
  }
}

function isValidSender(value) {
  if (typeof value !== 'string' || value.length > 254) return false
  const address = value.match(/<([^<>]+)>/)?.[1] ?? value
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address.trim())
}
