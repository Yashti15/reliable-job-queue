import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env?.VITE_API_BASE_URL || '/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 10_000,
  withCredentials: true,
})

let inMemoryCsrfToken = null

export function setCsrfToken(token) {
  inMemoryCsrfToken = token
}

export function getCachedCsrfToken() {
  return inMemoryCsrfToken || readCookie('rq_csrf')
}

function readCookie(name) {
  const prefix = `${name}=`
  const entry = typeof document !== 'undefined' && document.cookie
    ? document.cookie.split('; ').find((cookie) => cookie.startsWith(prefix))
    : undefined
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : undefined
}

api.interceptors.request.use((config) => {
  if (!['get', 'head', 'options'].includes(config.method?.toLowerCase())) {
    const csrfToken = inMemoryCsrfToken || readCookie('rq_csrf')
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

export function getSocketOrigin(env = import.meta.env) {
  if (env?.VITE_SOCKET_URL) {
    return env.VITE_SOCKET_URL
  }
  if (env?.VITE_WS_URL) {
    return env.VITE_WS_URL
  }
  const windowOrigin = typeof window !== 'undefined' ? window.location?.origin : 'http://localhost:5173'
  const apiBase = env?.VITE_API_BASE_URL || '/api'
  if (apiBase.startsWith('http://') || apiBase.startsWith('https://')) {
    return new URL(apiBase).origin
  }
  return windowOrigin
}

export function getSocketToken() {
  return api.get('/auth/socket-token')
}

export async function getCsrfToken() {
  const response = await api.get('/auth/csrf')
  if (response.data?.data?.csrfToken) {
    inMemoryCsrfToken = response.data.data.csrfToken
  }
  return response
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

export function getJobs({
  page = 1,
  limit = 10,
  status,
  type,
  priority,
  q,
  startDate,
  endDate,
} = {}) {
  const params = {
    page,
    limit,
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(priority ? { priority } : {}),
    ...(q ? { q } : {}),
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
  }
  return api.get('/jobs', { params })
}

export function getJob(jobId) {
  return api.get(`/jobs/${encodeURIComponent(jobId)}`)
}

export function retryJob(jobId, data) {
  return api.post(`/jobs/${encodeURIComponent(jobId)}/retry`, data)
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
  const baseUrl = import.meta.env?.VITE_API_BASE_URL || '/api'
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
