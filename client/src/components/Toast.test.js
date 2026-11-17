import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToastProvider } from './Toast.jsx'

test('ToastProvider renders children and toast container', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      ToastProvider,
      null,
      React.createElement('div', { id: 'test-child' }, 'App Content'),
    ),
  )

  assert.ok(html.includes('App Content'))
  assert.ok(html.includes('aria-live="polite"'))
})
