import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { EmptyState, ErrorState, LoadingState } from './Feedback.jsx'

test('ErrorState renders alert role and error message', () => {
  const html = renderToStaticMarkup(
    React.createElement(ErrorState, { message: 'Database connection failed' }),
  )
  assert.ok(html.includes('role="alert"'))
  assert.ok(html.includes('Something went wrong'))
  assert.ok(html.includes('Database connection failed'))
})

test('LoadingState renders status role and screen reader label', () => {
  const html = renderToStaticMarkup(
    React.createElement(LoadingState, { label: 'Fetching workers' }),
  )
  assert.ok(html.includes('role="status"'))
  assert.ok(html.includes('Fetching workers'))
  assert.ok(html.includes('animate-pulse'))
})

test('EmptyState renders title and description', () => {
  const html = renderToStaticMarkup(
    React.createElement(EmptyState, {
      title: 'No pending jobs',
      description: 'Create a job to see it listed here.',
    }),
  )
  assert.ok(html.includes('No pending jobs'))
  assert.ok(html.includes('Create a job to see it listed here.'))
})
