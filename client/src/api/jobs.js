import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 10_000,
  withCredentials: true,
})

function readCookie(name) {
  const prefix = `${name}=`
  const entry = document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix))
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : undefined
}

api.interceptors.request.use((config) => {
  if (!['get', 'head', 'options'].includes(config.method?.toLowerCase())) {
    const csrfToken = readCookie('rq_csrf')
    if (csrfToken) config.headers.set('X-CSRF-Token', csrfToken)
  }
  return config
})

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const url = error.config?.url || ''
    if (
      error.response?.status === 401 &&
      !url.startsWith('/auth/login') &&
      !url.startsWith('/auth/register') &&
      !url.startsWith('/auth/me')
    ) {
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
    return Promise.reject(error)
  },
)

export function getSocketOrigin() {
  return new URL(import.meta.env.VITE_API_BASE_URL || '/api', window.location.origin).origin
}

export function getCsrfToken() {
  return api.get('/auth/csrf')
}

export function registerAccount(details) {
  return api.post('/auth/register', details)
}

export function loginAccount(credentials) {
  return api.post('/auth/login', credentials)
}

export function getCurrentUser() {
  return api.get('/auth/me')
}

export function logoutAccount() {
  return api.post('/auth/logout')
}

export function getHealth() {
  return api.get('/health')
}

export function getAnalytics() {
  return api.get('/analytics')
}

export function getWorkers() {
  return api.get('/workers')
}

export function getJobs({ page = 1, limit = 10, status } = {}) {
  return api.get('/jobs', { params: { page, limit, ...(status ? { status } : {}) } })
}

export function getJob(jobId) {
  return api.get(`/jobs/${encodeURIComponent(jobId)}`)
}

export function createJob(job) {
  return api.post('/jobs', job)
}

export function uploadImage(file) {
  return api.post('/uploads/images', file, {
    headers: { 'Content-Type': file.type },
    timeout: 30_000,
  })
}

export function getArtifactDownloadUrl(jobId, assetId) {
  const baseUrl = import.meta.env.VITE_API_BASE_URL || '/api'
  return `${baseUrl.replace(/\/$/, '')}/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(assetId)}`
}

export function cancelJob(jobId) {
  return api.delete(`/jobs/${encodeURIComponent(jobId)}`)
}

export function getDeadJobs({ page = 1, limit = 10 } = {}) {
  return api.get('/jobs/dead', { params: { page, limit } })
}

export function replayJob(jobId) {
  return api.post(`/jobs/${encodeURIComponent(jobId)}/replay`)
}

export function getApiErrorMessage(error) {
  return (
    error?.response?.data?.error?.message ||
    (error?.code === 'ECONNABORTED'
      ? 'The API request timed out. Please try again.'
      : error?.response
        ? 'The server could not complete this request.'
        : 'Cannot reach the API. Check that the backend is running and try again.')
  )
}
