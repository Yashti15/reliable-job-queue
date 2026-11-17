import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  getApiErrorMessage,
  getArtifactDownloadUrl,
  getCachedCsrfToken,
  getSocketOrigin,
  setCsrfToken,
} from './jobs.js'

test('getApiErrorMessage extracts server response message', () => {
  const error = {
    response: {
      data: {
        error: {
          message: 'Uploaded image was not found for this account.',
        },
      },
    },
  }
  assert.equal(getApiErrorMessage(error), 'Uploaded image was not found for this account.')
})

test('getApiErrorMessage handles timeouts and network failures gracefully', () => {
  const timeoutError = { code: 'ECONNABORTED' }
  assert.equal(getApiErrorMessage(timeoutError), 'The API request timed out. Please try again.')

  const serverErrorWithoutMessage = { response: { status: 500 } }
  assert.equal(
    getApiErrorMessage(serverErrorWithoutMessage),
    'The server could not complete this request.',
  )

  const networkError = new Error('Network error')
  assert.equal(
    getApiErrorMessage(networkError),
    'Cannot reach the API. Check that the backend is running and try again.',
  )
})

test('getArtifactDownloadUrl constructs expected URL', () => {
  const url = getArtifactDownloadUrl('job-123', 'asset-456')
  assert.ok(url.includes('/jobs/job-123/artifacts/asset-456'))
})

test('setCsrfToken stores token in memory for cross-origin API requests', () => {
  setCsrfToken('test-in-memory-csrf-token')
  assert.equal(getCachedCsrfToken(), 'test-in-memory-csrf-token')
})

test('getSocketOrigin returns VITE_SOCKET_URL when configured for cross-origin websocket connection', () => {
  const origin = getSocketOrigin({ VITE_SOCKET_URL: 'https://reliable-job-queue-bnjm.onrender.com' })
  assert.equal(origin, 'https://reliable-job-queue-bnjm.onrender.com')
})

test('getSocketOrigin falls back to VITE_WS_URL when VITE_SOCKET_URL is not set', () => {
  const origin = getSocketOrigin({ VITE_WS_URL: 'wss://backend.example.com' })
  assert.equal(origin, 'wss://backend.example.com')
})

test('getSocketOrigin extracts origin from absolute VITE_API_BASE_URL', () => {
  const origin = getSocketOrigin({ VITE_API_BASE_URL: 'https://reliable-job-queue-bnjm.onrender.com/api' })
  assert.equal(origin, 'https://reliable-job-queue-bnjm.onrender.com')
})

test('getSocketOrigin defaults to window origin or localhost when using relative proxy URL', () => {
  const origin = getSocketOrigin({ VITE_API_BASE_URL: '/api' })
  assert.equal(origin, 'http://localhost:5173')
})
