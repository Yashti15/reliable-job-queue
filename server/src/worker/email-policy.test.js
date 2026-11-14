import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getEmailPolicy, isAllowedEmailRecipient } from './email-policy.js'

test('shared-provider email is disabled without an explicit opt-in', () => {
  const policy = getEmailPolicy({})
  assert.equal(policy.enabled, false)
  assert.equal(policy.configured, false)
})

test('email opt-in requires a valid non-empty recipient allowlist and quotas', () => {
  assert.equal(
    getEmailPolicy({ EMAIL_SENDING_ENABLED: 'true' }).enabled,
    false,
  )
  assert.equal(
    getEmailPolicy({
      EMAIL_SENDING_ENABLED: 'true',
      EMAIL_ALLOWED_RECIPIENTS: '@example.test',
      EMAIL_DAILY_QUOTA_PER_USER: '0',
    }).enabled,
    false,
  )

  const configured = getEmailPolicy({
    EMAIL_SENDING_ENABLED: 'true',
    EMAIL_ALLOWED_RECIPIENTS: 'learner@example.test, @approved.test',
    EMAIL_DAILY_QUOTA_PER_USER: '4',
    EMAIL_DAILY_QUOTA_GLOBAL: '50',
    EMAIL_JOBS_PER_MINUTE: '2',
  })
  assert.equal(configured.enabled, true)
  assert.equal(configured.dailyUserQuota, 4)
  assert.equal(configured.dailyGlobalQuota, 50)
  assert.equal(configured.perMinuteUserLimit, 2)
})

test('recipient matching permits only exact addresses and exact allowed domains', () => {
  const recipients = ['learner@example.test', '@approved.test']
  assert.equal(isAllowedEmailRecipient('Learner@Example.Test', recipients), true)
  assert.equal(isAllowedEmailRecipient('person@approved.test', recipients), true)
  assert.equal(isAllowedEmailRecipient('person@sub.approved.test', recipients), false)
  assert.equal(isAllowedEmailRecipient('person@attacker.test', recipients), false)
  assert.equal(isAllowedEmailRecipient('not-an-email', recipients), false)
  assert.equal(isAllowedEmailRecipient('any@random.org', ['*']), true)
})

test('EMAIL_DEMO_MODE enables safe mocked delivery with default demo allowlist', () => {
  const demoPolicy = getEmailPolicy({ EMAIL_DEMO_MODE: 'true' })
  assert.equal(demoPolicy.enabled, true)
  assert.equal(demoPolicy.isDemoMode, true)
  assert.ok(demoPolicy.allowedRecipients.includes('@example.test'))
  assert.equal(isAllowedEmailRecipient('operator@example.test', demoPolicy.allowedRecipients), true)
})
