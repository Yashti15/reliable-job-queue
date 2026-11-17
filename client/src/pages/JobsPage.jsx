import { useCallback, useEffect, useState } from 'react'
import { cancelJob, getApiErrorMessage, getJobs, retryJob } from '../api/jobs.js'
import { navigate } from '../components/AppLink.jsx'
import { ErrorState } from '../components/Feedback.jsx'
import { JobsPanel } from '../components/JobsPanel.jsx'
import { PageHeader } from '../components/PageHeader.jsx'
import { useQueueRealtime } from '../realtime/RealtimeProvider.jsx'
import { useToast } from '../components/Toast.jsx'

const statuses = ['', 'pending', 'processing', 'completed', 'failed', 'dead']
const priorities = ['', 'high', 'normal', 'low']
const jobTypes = ['', 'generate_pdf', 'process_image', 'send_email']

export function JobsPage({ search }) {
  const { jobRefreshVersion } = useQueueRealtime()
  const query = new URLSearchParams(search)
  const selectedStatus = statuses.includes(query.get('status') || '')
    ? query.get('status') || ''
    : ''
  const selectedPriority = priorities.includes(query.get('priority') || '')
    ? query.get('priority') || ''
    : ''
  const selectedType = jobTypes.includes(query.get('type') || '')
    ? query.get('type') || ''
    : ''
  const searchQuery = query.get('q') || ''
  const page = Number(query.get('page')) || 1
  const { showToast } = useToast()

  const [data, setData] = useState({ jobs: [], pagination: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchInput, setSearchInput] = useState(searchQuery)
  const [cancellingId, setCancellingId] = useState('')
  const [retryingId, setRetryingId] = useState('')

  // Sync search input if URL changes externally
  useEffect(() => {
    setSearchInput(searchQuery)
  }, [searchQuery])

  const loadJobs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getJobs({
        page,
        limit: 10,
        status: selectedStatus || undefined,
        priority: selectedPriority || undefined,
        type: selectedType || undefined,
        q: searchQuery || undefined,
      })
      setData(response.data.data)
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [page, selectedStatus, selectedPriority, selectedType, searchQuery])

  useEffect(() => {
    loadJobs()
  }, [loadJobs, jobRefreshVersion])

  function updateQuery(updates) {
    const next = new URLSearchParams(search)
    for (const [key, val] of Object.entries(updates)) {
      if (val) {
        next.set(key, val)
      } else {
        next.delete(key)
      }
    }
    // Always reset to page 1 when changing filter or search
    if (!('page' in updates)) {
      next.delete('page')
    }
    navigate(`/jobs${next.size ? `?${next}` : ''}`)
  }

  function handleSearchSubmit(event) {
    event?.preventDefault()
    updateQuery({ q: searchInput.trim() })
  }

  function clearAllFilters() {
    setSearchInput('')
    navigate('/jobs')
  }

  function changePage(nextPage) {
    const next = new URLSearchParams(search)
    next.set('page', String(nextPage))
    navigate(`/jobs?${next}`)
  }

  async function handleCancel(job) {
    if (!window.confirm(`Cancel pending job ${job._id}? This removes it from the queue.`)) return
    setCancellingId(job._id)
    try {
      await cancelJob(job._id)
      showToast('Job cancelled successfully.', 'success')
      await loadJobs()
    } catch (requestError) {
      showToast(getApiErrorMessage(requestError), 'error')
    } finally {
      setCancellingId('')
    }
  }

  async function handleRetry(job) {
    if (!window.confirm(`Retry job ${job._id}? Its attempts will reset and it will return to the pending queue.`)) return
    setRetryingId(job._id)
    try {
      await retryJob(job._id)
      showToast(`Job ${job._id} was queued for retry.`, 'success')
      await loadJobs()
    } catch (requestError) {
      showToast(getApiErrorMessage(requestError), 'error')
    } finally {
      setRetryingId('')
    }
  }

  const hasActiveFilters = Boolean(selectedStatus || selectedPriority || selectedType || searchQuery)

  return (
    <>
      <PageHeader
        eyebrow="Job management"
        title="All jobs"
        description="Inspect queue state, schedules, priorities, and worker ownership."
        action={
          <button
            type="button"
            onClick={loadJobs}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            ↻ <span className="ml-1">Refresh</span>
          </button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorState message={error} onRetry={loadJobs} />
        </div>
      )}

      <section className="mb-5 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <form onSubmit={handleSearchSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1 text-xs font-semibold text-slate-600">
            Search all jobs
            <div className="mt-1.5 flex gap-2">
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search job type, ID, or idempotency key"
                className="w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-normal text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
              />
              <button
                type="submit"
                className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
              >
                Search
              </button>
            </div>
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Status
            <select
              value={selectedStatus}
              onChange={(event) => updateQuery({ status: event.target.value })}
              className="mt-1.5 block w-full min-w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
            >
              <option value="">All statuses</option>
              <option value="pending">Pending</option>
              <option value="processing">Processing</option>
              <option value="completed">Completed</option>
              <option value="failed">Failed</option>
              <option value="dead">Dead letter</option>
            </select>
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Job type
            <select
              value={selectedType}
              onChange={(event) => updateQuery({ type: event.target.value })}
              className="mt-1.5 block w-full min-w-36 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
            >
              <option value="">All types</option>
              <option value="generate_pdf">PDF Report</option>
              <option value="process_image">Image Processing</option>
              <option value="send_email">Email Delivery</option>
            </select>
          </label>

          <label className="text-xs font-semibold text-slate-600">
            Priority
            <select
              value={selectedPriority}
              onChange={(event) => updateQuery({ priority: event.target.value })}
              className="mt-1.5 block w-full min-w-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
            >
              <option value="">All priorities</option>
              <option value="high">High</option>
              <option value="normal">Normal</option>
              <option value="low">Low</option>
            </select>
          </label>

          {hasActiveFilters && (
            <button
              type="button"
              onClick={clearAllFilters}
              className="h-9 rounded-xl border border-rose-200 px-3 py-1.5 text-xs font-semibold text-rose-700 hover:bg-rose-50"
            >
              Clear filters
            </button>
          )}
        </form>
      </section>

      {!error && (
        <JobsPanel
          jobs={data.jobs}
          loading={loading}
          pagination={data.pagination}
          onPageChange={changePage}
          onRetry={loadJobs}
          onCancel={handleCancel}
          cancellingId={cancellingId}
          onJobRetry={handleRetry}
          retryingId={retryingId}
          emptyTitle="No matching jobs"
          emptyDescription={
            hasActiveFilters
              ? 'No jobs match your current search and filter criteria. Try clearing filters.'
              : 'No jobs found in your queue. Create one to get started.'
          }
        />
      )}
    </>
  )
}
