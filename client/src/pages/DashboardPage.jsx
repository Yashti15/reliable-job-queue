import { useCallback, useEffect, useState } from 'react'
import { cancelJob, getAnalytics, getApiErrorMessage, getJobs, getWorkers, retryJob } from '../api/jobs.js'
import { AppLink, navigate } from '../components/AppLink.jsx'
import { ErrorState, SkeletonMetrics, SkeletonTable } from '../components/Feedback.jsx'
import { formatDate, JobTable } from '../components/JobTable.jsx'
import { PageHeader } from '../components/PageHeader.jsx'
import { useQueueRealtime } from '../realtime/RealtimeProvider.jsx'
import { useToast } from '../components/Toast.jsx'

const metricCards = [
  { key: 'total', label: 'Total jobs · 30 days', tint: 'bg-indigo-50 text-indigo-700', status: '' },
  { key: 'pending', label: 'Pending', tint: 'bg-amber-50 text-amber-700', status: 'pending' },
  { key: 'processing', label: 'Processing', tint: 'bg-sky-50 text-sky-700', status: 'processing' },
  { key: 'completed', label: 'Completed', tint: 'bg-emerald-50 text-emerald-700', status: 'completed' },
  { key: 'failed', label: 'Failed', tint: 'bg-orange-50 text-orange-700', status: 'failed' },
  { key: 'dead', label: 'Dead letter', tint: 'bg-rose-50 text-rose-700', status: 'dead' },
]

export function DashboardPage() {
  const { showToast } = useToast()
  const [metrics, setMetrics] = useState(null)
  const [recentJobs, setRecentJobs] = useState([])
  const [terminal, setTerminal] = useState(null)
  const [workers, setWorkers] = useState(null)
  const [byType, setByType] = useState([])
  const [dailyTrend, setDailyTrend] = useState([])
  const [averageExecutionDurationMs, setAverageExecutionDurationMs] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [cancellingId, setCancellingId] = useState('')
  const [retryingId, setRetryingId] = useState('')
  const { jobRefreshVersion, workerRefreshVersion } = useQueueRealtime()

  const loadDashboard = useCallback(async () => {
    setError('')
    try {
      const [analyticsResponse, recentResponse, workersResponse] = await Promise.all([
        getAnalytics(),
        getJobs({ page: 1, limit: 6 }),
        getWorkers(),
      ])
      const analytics = analyticsResponse.data.data
      setMetrics(analytics.jobs)
      setTerminal(analytics.terminal)
      setAverageExecutionDurationMs(analytics.averageExecutionDurationMs)
      setByType(analytics.byType || [])
      setDailyTrend(analytics.dailyTrend || [])
      setWorkers(workersResponse.data.data)
      setRecentJobs(recentResponse.data.data.jobs)
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadDashboard()
  }, [loadDashboard, jobRefreshVersion, workerRefreshVersion])

  async function handleCancel(job) {
    if (!window.confirm(`Cancel pending job ${job._id}?`)) return
    setCancellingId(job._id)
    try {
      await cancelJob(job._id)
      showToast('Job cancelled successfully.', 'success')
      await loadDashboard()
    } catch (err) {
      showToast(getApiErrorMessage(err), 'error')
    } finally {
      setCancellingId('')
    }
  }

  async function handleRetry(job) {
    if (!window.confirm(`Retry job ${job._id}?`)) return
    setRetryingId(job._id)
    try {
      await retryJob(job._id)
      showToast(`Job ${job._id} was queued for retry.`, 'success')
      await loadDashboard()
    } catch (err) {
      showToast(getApiErrorMessage(err), 'error')
    } finally {
      setRetryingId('')
    }
  }

  const workerCounts = workers?.counts || { active: 0, idle: 0, unresponsive: 0, disconnected: 0, total: 0 }
  const totalVolume = metrics?.total || 1

  return (
    <>
      <PageHeader
        eyebrow="Queue overview"
        title="Good day, operator"
        description="A live snapshot of job traffic and execution state across your queue."
        action={
          <button
            type="button"
            onClick={loadDashboard}
            className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
          >
            ↻ <span className="ml-1">Refresh</span>
          </button>
        }
      />

      {error ? (
        <ErrorState message={error} onRetry={loadDashboard} />
      ) : loading ? (
        <div className="space-y-6">
          <SkeletonMetrics count={6} />
          <SkeletonTable rows={4} />
        </div>
      ) : (
        <>
          <section aria-label="Job metrics" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {metricCards.map((card, index) => (
              <button
                type="button"
                key={card.key}
                onClick={() => navigate(card.status ? `/jobs?status=${card.status}` : '/jobs')}
                className="group rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-sm shadow-slate-200/50 transition hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
              >
                <div className="flex items-start justify-between">
                  <span className="text-sm font-medium text-slate-500">{card.label}</span>
                  <span className={`grid size-9 place-items-center rounded-xl text-sm font-bold ${card.tint}`}>
                    {['Σ', '◷', '↻', '✓', '!', '⌁'][index]}
                  </span>
                </div>
                <p className="mt-4 text-3xl font-bold tracking-tight text-slate-950">
                  {metrics[card.key].toLocaleString()}
                </p>
                <p className="mt-2 text-xs text-slate-400">Current status within the 30-day window</p>
              </button>
            ))}
          </section>

          <section className="mt-6 grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="font-bold tracking-tight text-slate-900">Execution health</h2>
                  <p className="mt-1 text-xs text-slate-500">Terminal jobs: completed, failed, and dead · last 30 days</p>
                </div>
                <p className="text-sm font-semibold text-slate-700">{terminal?.total ?? 0} terminal</p>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <div className="rounded-xl bg-emerald-50 p-4">
                  <p className="text-xs font-medium text-emerald-800">Success rate</p>
                  <p className="mt-2 text-2xl font-bold text-emerald-900">{terminal?.successRate ?? 0}%</p>
                </div>
                <div className="rounded-xl bg-rose-50 p-4">
                  <p className="text-xs font-medium text-rose-800">Failure rate</p>
                  <p className="mt-2 text-2xl font-bold text-rose-900">{terminal?.failureRate ?? 0}%</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="text-xs font-medium text-slate-600">Average execution</p>
                  <p className="mt-2 text-2xl font-bold text-slate-900">
                    {averageExecutionDurationMs === null
                      ? '—'
                      : formatDuration(averageExecutionDurationMs)}
                  </p>
                </div>
              </div>

              {/* Job Type Distribution Section */}
              {byType.length > 0 && (
                <div className="mt-6 border-t border-slate-100 pt-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Job Type Distribution
                  </h3>
                  <div className="mt-3 space-y-2.5">
                    {byType.map((item) => {
                      const pct = Math.round((item.count / totalVolume) * 100)
                      return (
                        <div key={item.type}>
                          <div className="flex justify-between text-xs font-medium text-slate-700">
                            <span className="font-mono">{item.type}</span>
                            <span>{item.count} ({pct}%)</span>
                          </div>
                          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-slate-100">
                            <div
                              className="h-full rounded-full bg-indigo-500 transition-all duration-300"
                              style={{ width: `${Math.max(4, pct)}%` }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="font-bold tracking-tight text-slate-900">Workers</h2>
                  <p className="mt-1 text-xs text-slate-500">{workerCounts.total} monitored · refreshed from MongoDB</p>
                </div>
                <span className="rounded-lg bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700">
                  {workerCounts.active} active
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-slate-100 px-2.5 py-1 text-slate-700">{workerCounts.idle} idle</span>
                <span className="rounded-full bg-amber-50 px-2.5 py-1 text-amber-800">{workerCounts.unresponsive} unresponsive</span>
                <span className="rounded-full bg-rose-50 px-2.5 py-1 text-rose-700">{workerCounts.disconnected} stopped</span>
              </div>
              {workers?.workers?.length ? (
                <ul className="mt-4 divide-y divide-slate-100">
                  {workers.workers.slice(0, 4).map((worker) => (
                    <li key={worker.workerId} className="flex items-center justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-semibold text-slate-700">{worker.workerId}</p>
                        {worker.currentJobId && (
                          <button type="button" onClick={() => navigate(`/jobs/${worker.currentJobId}`)} className="mt-1 truncate text-[11px] text-indigo-700 hover:underline">
                            {worker.currentJobType} · {worker.currentJobId}
                          </button>
                        )}
                      </div>
                      <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold ${worker.state === 'active' ? 'bg-emerald-50 text-emerald-700' : worker.state === 'idle' ? 'bg-slate-100 text-slate-600' : worker.state === 'unresponsive' ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-700'}`}>
                        {worker.state}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-sm text-slate-500">No worker has registered yet. Start the worker process to see its heartbeat.</p>
              )}

              {/* 7-Day Activity Trend */}
              {dailyTrend.length > 0 && (
                <div className="mt-6 border-t border-slate-100 pt-5">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Recent Activity Trend
                  </h3>
                  <div className="mt-3 flex items-end gap-1.5 h-20">
                    {dailyTrend.map((day) => {
                      const maxDaily = Math.max(...dailyTrend.map((d) => d.total), 1)
                      const heightPct = Math.round((day.total / maxDaily) * 100)
                      return (
                        <div
                          key={day._id}
                          className="group relative flex-1 flex flex-col items-center h-full justify-end"
                        >
                          <div
                            className="w-full rounded-t bg-indigo-500 hover:bg-indigo-600 transition"
                            style={{ height: `${Math.max(10, heightPct)}%` }}
                            title={`${day._id}: ${day.total} jobs (${day.completed} completed, ${day.failed} failed)`}
                          />
                          <span className="mt-1 text-[9px] text-slate-400 font-mono">
                            {day._id.slice(5)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>
          </section>

          <section className="mt-8">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold tracking-tight text-slate-900">Recent jobs</h2>
                <p className="mt-1 text-sm text-slate-500">Latest jobs submitted to the queue</p>
              </div>
              <AppLink href="/jobs" className="text-sm font-semibold text-indigo-700 hover:text-indigo-900">
                View all jobs <span aria-hidden="true">→</span>
              </AppLink>
            </div>
            {recentJobs.length ? (
              <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm shadow-slate-200/40">
                <JobTable
                  jobs={recentJobs}
                  onCancel={handleCancel}
                  cancellingId={cancellingId}
                  onRetry={handleRetry}
                  retryingId={retryingId}
                />
                <div className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
                  Updated {formatDate(new Date())}
                </div>
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center">
                <p className="font-semibold text-slate-800">Your queue is quiet</p>
                <p className="mt-1 text-sm text-slate-500">Create your first job to see it show up here.</p>
                <AppLink href="/create" className="mt-4 inline-flex rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                  Create a job
                </AppLink>
              </div>
            )}
          </section>
        </>
      )}
    </>
  )
}

function formatDuration(durationMs) {
  if (durationMs < 1000) return `${durationMs} ms`
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)} s`
  return `${(durationMs / 60_000).toFixed(1)} min`
}
