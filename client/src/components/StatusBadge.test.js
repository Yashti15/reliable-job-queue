import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StatusBadge } from './StatusBadge.jsx'

test('StatusBadge renders correct status styles and label', () => {
  const statuses = [
    { status: 'pending', expectedClass: 'bg-amber-50 text-amber-700' },
    { status: 'processing', expectedClass: 'bg-sky-50 text-sky-700' },
    { status: 'completed', expectedClass: 'bg-emerald-50 text-emerald-700' },
    { status: 'failed', expectedClass: 'bg-orange-50 text-orange-700' },
    { status: 'dead', expectedClass: 'bg-rose-50 text-rose-700' },
    { status: undefined, expectedClass: 'bg-slate-100 text-slate-600' },
  ]

  for (const { status, expectedClass } of statuses) {
    const html = renderToStaticMarkup(React.createElement(StatusBadge, { status }))
    assert.ok(html.includes(expectedClass), `Expected ${status} to include ${expectedClass}`)
    assert.ok(html.includes(status || 'unknown'), `Expected ${status} label in HTML`)
  }
})
