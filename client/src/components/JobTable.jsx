import { AppLink } from './AppLink.jsx'
import { StatusBadge } from './StatusBadge.jsx'

export function formatDate(value, options = {}) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
    ...options,
  }).format(date)
}

function shortenId(id = '') {
  return `${String(id).slice(0, 8)}…${String(id).slice(-5)}`
}

export function JobTable({ jobs, onCancel, cancellingId, onRetry, retryingId }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[850px] text-left">
          <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-5 py-3.5">Job</th>
              <th className="px-4 py-3.5">Status</th>
              <th className="px-4 py-3.5">Priority</th>
              <th className="px-4 py-3.5">Attempts</th>
              <th className="px-4 py-3.5">Created</th>
              <th className="px-4 py-3.5">Scheduled</th>
              <th className="px-4 py-3.5">Worker</th>
              <th className="px-4 py-3.5"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {jobs.map((job) => (
              <tr key={job._id} className="transition hover:bg-slate-50/70">
                <td className="px-5 py-4">
                  <AppLink href={`/jobs/${job._id}`} className="font-semibold text-indigo-700 hover:text-indigo-900">
                    {job.type}
                  </AppLink>
                  <p title={job._id} className="mt-1 font-mono text-[11px] text-slate-400">
                    {shortenId(job._id)}
                  </p>
                </td>
                <td className="px-4 py-4">
                  <StatusBadge status={job.status} />
                  {job.status === 'processing' && typeof job.progress?.percent === 'number' && (
                    <div className="mt-1.5 w-24">
                      <div className="flex justify-between text-[10px] font-medium text-slate-500">
                        <span>{job.progress.stage || 'running'}</span>
                        <span>{job.progress.percent}%</span>
                      </div>
                      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                        <div
                          className="h-full rounded-full bg-sky-500 transition-all duration-300"
                          style={{ width: `${Math.max(5, job.progress.percent)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </td>
                <td className="px-4 py-4">
                  <span className={`text-xs font-semibold capitalize ${job.priority === 'high' ? 'text-rose-600' : job.priority === 'low' ? 'text-slate-500' : 'text-slate-700'}`}>
                    {job.priority || 'normal'}
                  </span>
                </td>
                <td className="px-4 py-4 text-sm text-slate-600">
                  <span className="font-semibold text-slate-800">{job.attempts ?? 0}</span>
                  <span className="text-slate-400"> / {job.maxAttempts ?? '—'}</span>
                </td>
                <td className="px-4 py-4 text-xs text-slate-500">{formatDate(job.createdAt)}</td>
                <td className="px-4 py-4 text-xs text-slate-500">{formatDate(job.runAt)}</td>
                <td className="px-4 py-4 text-xs text-slate-500">{job.workerId || '—'}</td>
                <td className="px-4 py-4 text-right">
                  <div className="flex items-center justify-end gap-2">
                    {job.status === 'pending' && onCancel && (
                      <button
                        type="button"
                        disabled={cancellingId === job._id}
                        onClick={() => onCancel(job)}
                        className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 hover:border-rose-200 hover:text-rose-700 disabled:opacity-50"
                      >
                        {cancellingId === job._id ? 'Cancelling…' : 'Cancel'}
                      </button>
                    )}
                    {['failed', 'dead'].includes(job.status) && onRetry && (
                      <button
                        type="button"
                        disabled={retryingId === job._id}
                        onClick={() => onRetry(job)}
                        className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50"
                      >
                        {retryingId === job._id ? 'Retrying…' : 'Retry'}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
