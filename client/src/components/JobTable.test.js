import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { formatDate, JobTable } from './JobTable.jsx'

test('formatDate handles valid dates, invalid values, and falsy input', () => {
  assert.equal(formatDate(null), '—')
  assert.equal(formatDate(undefined), '—')
  assert.equal(formatDate('invalid-date'), '—')

  const formatted = formatDate(new Date('2026-11-15T12:00:00Z'))
  assert.notEqual(formatted, '—')
  assert.ok(formatted.length > 3)
})

test('JobTable renders job rows with status badges and cancel actions', () => {
  const jobs = [
    {
      _id: '507f1f77bcf86cd799439011',
      type: 'send_email',
      status: 'pending',
      priority: 'high',
      attempts: 0,
      maxAttempts: 3,
      createdAt: '2026-11-15T12:00:00Z',
      runAt: '2026-11-15T12:00:00Z',
      workerId: null,
    },
    {
      _id: '507f1f77bcf86cd799439022',
      type: 'generate_pdf',
      status: 'completed',
      priority: 'normal',
      attempts: 1,
      maxAttempts: 3,
      createdAt: '2026-11-15T12:00:00Z',
      runAt: '2026-11-15T12:00:00Z',
      workerId: 'worker-1',
    },
  ]

  const html = renderToStaticMarkup(
    React.createElement(JobTable, {
      jobs,
      onCancel: () => {},
      cancellingId: '',
    }),
  )

  assert.ok(html.includes('send_email'))
  assert.ok(html.includes('generate_pdf'))
  assert.ok(html.includes('Cancel'), 'Cancel button should be visible for pending job')
  assert.ok(html.includes('worker-1'))
})

test('JobTable renders progress bar for processing jobs', () => {
  const jobs = [
    {
      _id: '507f1f77bcf86cd799439033',
      type: 'process_image',
      status: 'processing',
      priority: 'high',
      attempts: 1,
      maxAttempts: 3,
      createdAt: '2026-11-15T12:00:00Z',
      runAt: '2026-11-15T12:00:00Z',
      workerId: 'worker-2',
      progress: {
        percent: 65,
        stage: 'resizing',
      },
    },
  ]

  const html = renderToStaticMarkup(React.createElement(JobTable, { jobs }))
  assert.ok(html.includes('resizing'))
  assert.ok(html.includes('65%'))
})

test('JobTable renders retry button for failed and dead jobs', () => {
  const jobs = [
    {
      _id: '507f1f77bcf86cd799439044',
      type: 'send_email',
      status: 'failed',
      attempts: 2,
      maxAttempts: 3,
      createdAt: '2026-11-15T12:00:00Z',
    },
    {
      _id: '507f1f77bcf86cd799439055',
      type: 'generate_pdf',
      status: 'dead',
      attempts: 3,
      maxAttempts: 3,
      createdAt: '2026-11-15T12:00:00Z',
    },
  ]

  const html = renderToStaticMarkup(
    React.createElement(JobTable, {
      jobs,
      onRetry: () => {},
      retryingId: '',
    }),
  )
  assert.ok(html.includes('Retry'))
})
