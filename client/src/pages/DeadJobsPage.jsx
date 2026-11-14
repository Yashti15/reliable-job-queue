import { useCallback, useEffect, useState } from 'react'
import { getApiErrorMessage, getDeadJobs, replayJob } from '../api/jobs.js'
import { navigate } from '../components/AppLink.jsx'
import { EmptyState, ErrorState, LoadingState } from '../components/Feedback.jsx'
import { formatDate } from '../components/JobTable.jsx'
import { Pagination } from '../components/Pagination.jsx'
import { PageHeader } from '../components/PageHeader.jsx'
import { useQueueRealtime } from '../realtime/RealtimeProvider.jsx'

export function DeadJobsPage() {
  const { jobRefreshVersion } = useQueueRealtime()
  const [page, setPage] = useState(1)
  const [jobs, setJobs] = useState([])
  const [pagination, setPagination] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [replayingId, setReplayingId] = useState('')
  const [notice, setNotice] = useState('')

  const loadDeadJobs = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getDeadJobs({ page, limit: 10 })
      setJobs(response.data.data.jobs)
      setPagination(response.data.data.pagination)
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [page])

  useEffect(() => {
    loadDeadJobs()
  }, [loadDeadJobs, jobRefreshVersion])

  async function handleReplay(job) {
    if (!window.confirm(`Replay job ${job._id}? Its attempts will reset and it will return to the pending queue.`)) {
      return
    }
    setReplayingId(job._id)
    setNotice('')
    setError('')
    try {
      await replayJob(job._id)
      setNotice(`Job ${job._id} was replayed and returned to the pending queue.`)
      await loadDeadJobs()
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setReplayingId('')
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Failure recovery"
        title="Dead letter queue"
        description="Review jobs that exhausted their attempts. Replay returns a job to normal scheduling and records an audit entry."
        action={<button type="button" onClick={loadDeadJobs} className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50">↻ <span className="ml-1">Refresh</span></button>}
      />
      {notice && <p role="status" className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">{notice}</p>}
      {error && <div className="mb-4"><ErrorState message={error} onRetry={loadDeadJobs} /></div>}

      {loading ? (
        <LoadingState label="Loading dead-letter jobs" />
      ) : error ? null : jobs.length === 0 ? (
        <EmptyState title="No dead jobs" description="Jobs that exhaust their retry or crash-recovery attempt limit will appear here." />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[790px] text-left">
              <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-5 py-3.5">Job</th>
                  <th className="px-4 py-3.5">Final error</th>
                  <th className="px-4 py-3.5">Attempts</th>
                  <th className="px-4 py-3.5">Dead at</th>
                  <th className="px-4 py-3.5">Replay count</th>
                  <th className="px-4 py-3.5"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((job) => (
                  <tr key={job._id} className="align-top hover:bg-slate-50/70">
                    <td className="px-5 py-4">
                      <button type="button" onClick={() => navigate(`/jobs/${job._id}`)} className="font-semibold text-indigo-700 hover:text-indigo-900">{job.type}</button>
                      <p className="mt-1 max-w-48 truncate font-mono text-[11px] text-slate-400" title={job._id}>{job._id}</p>
                    </td>
                    <td className="max-w-sm px-4 py-4 text-xs leading-5 text-rose-700">{job.lastError || 'No final error was recorded.'}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-sm font-semibold text-slate-700">{job.attempts} / {job.maxAttempts}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{formatDate(job.deadAt)}</td>
                    <td className="px-4 py-4 text-sm text-slate-600">{job.replayCount ?? 0}</td>
                    <td className="whitespace-nowrap px-4 py-4 text-right">
                      <button type="button" disabled={replayingId === job._id} onClick={() => handleReplay(job)} className="rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
                        {replayingId === job._id ? 'Replaying…' : 'Replay'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination pagination={pagination} onPageChange={setPage} />
        </div>
      )}
    </>
  )
}
