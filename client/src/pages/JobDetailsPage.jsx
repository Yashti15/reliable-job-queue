import { useCallback, useEffect, useState } from 'react'
import { cancelJob, getApiErrorMessage, getJob, getArtifactDownloadUrl, retryJob } from '../api/jobs.js'
import { AppLink, navigate } from '../components/AppLink.jsx'
import { ErrorState, LoadingState } from '../components/Feedback.jsx'
import { formatDate } from '../components/JobTable.jsx'
import { PageHeader } from '../components/PageHeader.jsx'
import { StatusBadge } from '../components/StatusBadge.jsx'
import { useQueueRealtime } from '../realtime/RealtimeProvider.jsx'
import { useToast } from '../components/Toast.jsx'

function Detail({ label, children, mono = false }) {
  if (children === undefined || children === null || children === '') return null
  return (
    <div className="min-w-0 border-b border-slate-100 py-4 last:border-b-0">
      <dt className="text-xs font-medium text-slate-500">{label}</dt>
      <dd className={`mt-1.5 break-words text-sm text-slate-800 ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  )
}

export function JobDetailsPage({ jobId }) {
  const { jobRefreshVersion } = useQueueRealtime()
  const { showToast } = useToast()
  const [job, setJob] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionLoading, setActionLoading] = useState(false)
  const [copied, setCopied] = useState(false)

  const loadJob = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const response = await getJob(jobId)
      setJob(response.data.data.job)
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    loadJob()
  }, [loadJob, jobRefreshVersion])

  async function copyId() {
    try {
      await navigator.clipboard.writeText(job._id)
      setCopied(true)
      showToast('Job ID copied to clipboard.', 'info')
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      showToast('Could not copy the job ID to clipboard.', 'error')
    }
  }

  async function handleCancel() {
    if (!window.confirm(`Cancel pending job ${job._id}? This removes it from the queue.`)) return
    setActionLoading(true)
    try {
      await cancelJob(job._id)
      showToast('Job was cancelled successfully.', 'success')
      await loadJob()
    } catch (requestError) {
      showToast(getApiErrorMessage(requestError), 'error')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleRetry() {
    if (!window.confirm(`Retry job ${job._id}? It will be scheduled for immediate execution.`)) return
    setActionLoading(true)
    try {
      await retryJob(job._id)
      showToast('Job was successfully queued for retry.', 'success')
      await loadJob()
    } catch (requestError) {
      showToast(getApiErrorMessage(requestError), 'error')
    } finally {
      setActionLoading(false)
    }
  }

  return (
    <>
      <PageHeader
        eyebrow="Job record"
        title="Job details"
        description="Inspect the persisted job input, lifecycle timestamps, worker lease, and dead-letter audit history."
        action={
          <div className="flex items-center gap-2">
            <AppLink
              href="/jobs"
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50"
            >
              ← <span className="ml-1">Back to jobs</span>
            </AppLink>
            {job?.status === 'pending' && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleCancel}
                className="rounded-xl border border-rose-200 bg-white px-4 py-2.5 text-sm font-semibold text-rose-700 shadow-sm hover:bg-rose-50 disabled:opacity-50"
              >
                {actionLoading ? 'Cancelling…' : 'Cancel job'}
              </button>
            )}
            {job && ['failed', 'dead', 'completed'].includes(job.status) && (
              <button
                type="button"
                disabled={actionLoading}
                onClick={handleRetry}
                className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
              >
                {actionLoading ? 'Retrying…' : 'Retry job'}
              </button>
            )}
          </div>
        }
      />

      {loading ? (
        <LoadingState label="Loading job details" />
      ) : error ? (
        <ErrorState message={error} onRetry={loadJob} />
      ) : job ? (
        <div className="grid gap-5 xl:grid-cols-[minmax(0,1.3fr)_minmax(300px,0.7fr)]">
          <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm shadow-slate-200/40 md:p-7">
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Queue record</p>
                <h2 className="mt-1 break-all font-mono text-sm font-semibold text-slate-800">{job._id}</h2>
              </div>
              <button
                type="button"
                onClick={copyId}
                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50"
              >
                {copied ? 'Copied' : 'Copy ID'}
              </button>
            </div>

            {/* Live Progress Bar for Processing Jobs */}
            {job.status === 'processing' && (
              <div className="my-5 rounded-xl border border-sky-200 bg-sky-50/70 p-4">
                <div className="flex items-center justify-between text-xs font-semibold text-sky-900">
                  <span className="flex items-center gap-1.5">
                    <span className="size-2 animate-ping rounded-full bg-sky-500" />
                    <span>Processing in progress</span>
                    {job.progress?.stage && (
                      <span className="rounded bg-sky-200 px-2 py-0.5 text-[11px] font-mono uppercase text-sky-800">
                        {job.progress.stage}
                      </span>
                    )}
                  </span>
                  <span>{job.progress?.percent ?? 0}%</span>
                </div>
                <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-sky-200">
                  <div
                    className="h-full rounded-full bg-sky-600 transition-all duration-300"
                    style={{ width: `${Math.max(5, job.progress?.percent ?? 0)}%` }}
                  />
                </div>
                {job.progress?.message && (
                  <p className="mt-2 text-xs text-sky-800">{job.progress.message}</p>
                )}
              </div>
            )}

            <dl className="grid gap-x-8 sm:grid-cols-2">
              <Detail label="Status"><StatusBadge status={job.status} /></Detail>
              <Detail label="Job type">{job.type}</Detail>
              <Detail label="Priority">{job.priority}</Detail>
              <Detail label="Attempts">{job.attempts} / {job.maxAttempts}</Detail>
              <Detail label="Scheduled for">{formatDate(job.runAt)}</Detail>
              <Detail label="Created">{formatDate(job.createdAt)}</Detail>
              <Detail label="Last updated">{formatDate(job.updatedAt)}</Detail>
              <Detail label="Claimed at">{formatDate(job.claimedAt)}</Detail>
              <Detail label="Completed at">{formatDate(job.completedAt)}</Detail>
              <Detail label="Worker ID" mono>{job.workerId}</Detail>
              <Detail label="Lease expires">{formatDate(job.leaseExpiresAt)}</Detail>
              <Detail label="Dead-lettered at">{formatDate(job.deadAt)}</Detail>
              <Detail label="Idempotency key" mono>{job.idempotencyKey}</Detail>
              <Detail label="Replay count">{job.replayCount}</Detail>
              {job.lastError && (
                <div className="sm:col-span-2">
                  <Detail label="Last error">
                    <span className="font-mono text-xs text-rose-700">{job.lastError}</span>
                  </Detail>
                </div>
              )}
            </dl>

            <div className="mt-4">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Payload</h3>
              <pre className="mt-2 overflow-x-auto rounded-xl bg-slate-950 p-4 text-xs leading-6 text-emerald-100">{JSON.stringify(job.payload, null, 2)}</pre>
            </div>
            {job.result && (
              <section className="mt-5 border-t border-slate-100 pt-5">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Execution result</h3>
                {job.result.type === 'email' ? (
                  <p className="mt-2 text-sm text-slate-700">
                    Provider accepted the email request. Acceptance does not confirm delivery to the recipient’s inbox.
                    {job.result.providerMessageId && <span className="mt-1 block font-mono text-xs text-slate-500">Provider reference: {job.result.providerMessageId}</span>}
                  </p>
                ) : (
                  <>
                    {job.result.title && <p className="mt-2 text-sm font-medium text-slate-800">{job.result.title}</p>}
                    {job.result.operation && <p className="mt-1 text-sm text-slate-600">Operation: {job.result.operation}; {job.result.width}×{job.result.height} {job.result.format}</p>}
                    <ul className="mt-3 space-y-2">
                      {job.result.artifacts?.map((artifact) => (
                        <li key={artifact.assetId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3 text-sm">
                          <div className="min-w-0 flex-1">
                            <span className="break-all text-slate-700">{artifact.fileName} · {(artifact.sizeBytes / 1024).toFixed(1)} KB</span>
                            {artifact.mediaType.startsWith('image/') && (
                              <img
                                src={getArtifactDownloadUrl(job._id, artifact.assetId)}
                                alt={`Processed image ${artifact.fileName}`}
                                className="mt-3 max-h-80 max-w-full rounded-lg border border-slate-200 object-contain"
                                loading="lazy"
                              />
                            )}
                          </div>
                          <a
                            href={getArtifactDownloadUrl(job._id, artifact.assetId)}
                            className="font-semibold text-indigo-700 underline underline-offset-2"
                            download
                          >
                            Download
                          </a>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>
            )}
          </section>

          <aside className="space-y-5">
            {/* Attempt History */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-900">Attempt history</h3>
              {job.attemptHistory?.length ? (
                <ol className="mt-4 space-y-4">
                  {[...job.attemptHistory].reverse().map((attempt) => (
                    <li key={`attempt-${attempt.attempt}`} className="border-l-2 border-indigo-300 pl-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-slate-800">
                          Attempt {attempt.attempt}
                        </span>
                        {attempt.durationMs !== undefined && (
                          <span className="text-[11px] text-slate-400 font-mono">
                            {attempt.durationMs} ms
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-slate-500">
                        {formatDate(attempt.startedAt)}
                        {attempt.workerId && <span className="ml-1 font-mono">· {attempt.workerId}</span>}
                      </p>
                      {attempt.error && (
                        <p className="mt-1 text-xs leading-5 text-rose-700 font-mono">
                          {attempt.error}
                        </p>
                      )}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-slate-500">
                  {job.attempts > 0
                    ? `${job.attempts} attempt(s) recorded.`
                    : 'No attempts have run yet.'}
                </p>
              )}
            </section>

            {/* Replay History */}
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <h3 className="font-semibold text-slate-900">Replay / retry history</h3>
              {job.replayHistory?.length ? (
                <ol className="mt-4 space-y-4">
                  {[...job.replayHistory].reverse().map((entry, index) => (
                    <li key={`${entry.replayedAt}-${index}`} className="border-l-2 border-indigo-200 pl-3">
                      <p className="text-xs font-semibold text-slate-800">Replay {job.replayHistory.length - index}</p>
                      <p className="mt-1 text-xs text-slate-500">{formatDate(entry.replayedAt)}</p>
                      <p className="mt-1 text-xs text-slate-600">Previous attempts: {entry.previousAttempts}</p>
                      {entry.previousLastError && <p className="mt-1 text-xs leading-5 text-rose-700">{entry.previousLastError}</p>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-slate-500">No replay actions recorded.</p>
              )}
            </section>

            {job.status === 'dead' && (
              <div className="rounded-2xl border border-rose-100 bg-rose-50 p-5">
                <p className="text-sm font-semibold text-rose-900">This job is in the dead-letter queue.</p>
                <AppLink href="/dead" className="mt-3 inline-flex text-sm font-semibold text-rose-800 underline underline-offset-2">Review and replay dead jobs</AppLink>
              </div>
            )}
          </aside>
        </div>
      ) : null}
    </>
  )
}
