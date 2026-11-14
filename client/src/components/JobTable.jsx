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

export function JobTable({ jobs, onCancel, cancellingId }) {
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
                <td className="px-4 py-4"><StatusBadge status={job.status} /></td>
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
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
