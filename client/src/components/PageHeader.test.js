import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { PageHeader } from './PageHeader.jsx'

test('PageHeader renders title, eyebrow, description, and action slot', () => {
  const html = renderToStaticMarkup(
    React.createElement(PageHeader, {
      eyebrow: 'Admin Area',
      title: 'Dead letter queue',
      description: 'Review failed jobs',
      action: React.createElement('button', null, 'Refresh'),
    }),
  )
  assert.ok(html.includes('Admin Area'))
  assert.ok(html.includes('Dead letter queue'))
  assert.ok(html.includes('Review failed jobs'))
  assert.ok(html.includes('<button>Refresh</button>'))
})
