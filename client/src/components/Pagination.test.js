import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Pagination } from './Pagination.jsx'

test('Pagination returns null when totalPages <= 1', () => {
  const html1 = renderToStaticMarkup(
    React.createElement(Pagination, { pagination: { page: 1, totalPages: 1, total: 5 } }),
  )
  assert.equal(html1, '')

  const htmlNull = renderToStaticMarkup(
    React.createElement(Pagination, { pagination: null }),
  )
  assert.equal(htmlNull, '')
})

test('Pagination renders page numbers and button states when multiple pages exist', () => {
  const htmlFirstPage = renderToStaticMarkup(
    React.createElement(Pagination, {
      pagination: { page: 1, totalPages: 4, total: 40 },
    }),
  )
  assert.ok(htmlFirstPage.includes('Page <span class="font-semibold text-slate-700">1</span>'))
  assert.ok(htmlFirstPage.includes('of <span class="font-semibold text-slate-700">4</span>'))
  assert.ok(htmlFirstPage.includes('· 40 total'))
  assert.ok(htmlFirstPage.includes('disabled=""'), 'Previous button should be disabled on first page')

  const htmlLastPage = renderToStaticMarkup(
    React.createElement(Pagination, {
      pagination: { page: 4, totalPages: 4, total: 40 },
    }),
  )
  assert.ok(htmlLastPage.includes('disabled=""'), 'Next button should be disabled on last page')
})
