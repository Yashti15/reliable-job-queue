import { AppLink } from './AppLink.jsx'
import { EmptyState, ErrorState, SkeletonTable } from './Feedback.jsx'
import { JobTable } from './JobTable.jsx'
import { Pagination } from './Pagination.jsx'

export function JobsPanel({
  jobs,
  loading,
  error,
  pagination,
  onPageChange,
  onRetry,
  onCancel,
  cancellingId,
  onJobRetry,
  retryingId,
  emptyTitle = 'No jobs found',
  emptyDescription = 'Jobs submitted to the queue will appear here.',
}) {
  if (loading) return <SkeletonTable rows={5} />
  if (error) return <ErrorState message={error} onRetry={onRetry} />
  if (!jobs.length) {
    return (
      <EmptyState
        title={emptyTitle}
        description={emptyDescription}
        action={
          <AppLink
            href="/create"
            className="mt-5 inline-flex rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Create a job
          </AppLink>
        }
      />
    )
  }
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <JobTable
        jobs={jobs}
        onCancel={onCancel}
        cancellingId={cancellingId}
        onRetry={onJobRetry}
        retryingId={retryingId}
      />
      <Pagination pagination={pagination} onPageChange={onPageChange} />
    </div>
  )
}
