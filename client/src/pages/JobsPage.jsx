import { useCallback, useEffect, useMemo, useState } from 'react'
import { cancelJob, getApiErrorMessage, getJobs } from '../api/jobs.js'
import { navigate } from '../components/AppLink.jsx'
import { ErrorState } from '../components/Feedback.jsx'
import { JobsPanel } from '../components/JobsPanel.jsx'
import { PageHeader } from '../components/PageHeader.jsx'
import { useQueueRealtime } from '../realtime/RealtimeProvider.jsx'

const statuses = ['', 'pending', 'processing', 'completed', 'failed', 'dead']

export function JobsPage({ search }) {
  const { jobRefreshVersion } = useQueueRealtime()
  const query = new URLSearchParams(search)
  const selectedStatus = statuses.includes(query.get('status') || '')
    ? query.get('status') || ''
    : ''
  const page = Number(query.get('page')) || 1
  const [data, setData] = useState({ jobs: [], pagination: null })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [searchText, setSearchText] = useState('')
  const [priority, setPriority] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [notice, setNotice] = useState('')

  const loadJobs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getJobs({ page, limit: 10, status: selectedStatus })
      setData(response.data.data)
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [page, selectedStatus])

  useEffect(() => {
    loadJobs()
  }, [loadJobs, jobRefreshVersion])

  const visibleJobs = useMemo(
    () =>
      data.jobs.filter((job) => {
        const searchMatches =
          !searchText ||
          job.type.toLowerCase().includes(searchText.toLowerCase()) ||
          String(job._id).toLowerCase().includes(searchText.toLowerCase())
        return searchMatches && (!priority || job.priority === priority)
      }),
    [data.jobs, priority, searchText],
  )

  function changeFilters(status) {
    const params = new URLSearchParams()
    if (status) params.set('status', status)
    navigate(`/jobs${params.size ? `?${params}` : ''}`)
  }

  function changePage(nextPage) {
    const params = new URLSearchParams()
    if (selectedStatus) params.set('status', selectedStatus)
    params.set('page', String(nextPage))
    navigate(`/jobs?${params}`)
  }

  async function handleCancel(job) {
    if (!window.confirm(`Cancel pending job ${job._id}? This removes it from the queue.`)) return
    setCancellingId(job._id)
    setNotice('')
    try {
      await cancelJob(job._id)
      setNotice('Job cancelled successfully.')
      await loadJobs()
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setCancellingId('')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Job management"
        title="All jobs"
        description="Inspect queue state, schedules, priorities, and worker ownership."
        action={
          <button type="button" onClick={loadJobs} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">
            ↻ <span className="ml-1">Refresh</span>
          </button>
        }
      />

      {notice && <p role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
      {error && <div className="mb-4"><ErrorState message={error} onRetry={loadJobs} /></div>}

      <section className="mb-5 flex flex-col gap-3 rounded-2xl border border-slate-200 bg-white p-4 sm:flex-row sm:items-end">
        <label className="flex-1 text-xs font-semibold text-slate-600">
          Search current page
          <input
            value={searchText}
            onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search job type or ID"
            className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-800 outline-none placeholder:text-slate-400 focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
          />
        </label>
        <label className="text-xs font-semibold text-slate-600">
          Status
          <select
            value={selectedStatus}
            onChange={(event) => changeFilters(event.target.value)}
            className="mt-1.5 block w-full min-w-40 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
          >
            {statuses.map((status) => <option key={status || 'all'} value={status}>{status ? status[0].toUpperCase() + status.slice(1) : 'All statuses'}</option>)}
          </select>
        </label>
        <label className="text-xs font-semibold text-slate-600">
          Priority · current page
          <select
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
            className="mt-1.5 block w-full min-w-36 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100"
          >
            <option value="">All priorities</option>
            <option value="high">High</option>
            <option value="normal">Normal</option>
            <option value="low">Low</option>
          </select>
        </label>
      </section>

      {!error && (
        <JobsPanel
          jobs={visibleJobs}
          loading={loading}
          pagination={data.pagination}
          onPageChange={changePage}
          onRetry={loadJobs}
          onCancel={handleCancel}
          cancellingId={cancellingId}
          emptyTitle="No matching jobs"
          emptyDescription="Try a different status, priority, or search term, or create a new job."
        />
      )}
    </>
  )
}
