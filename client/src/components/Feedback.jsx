export function ErrorState({ message, onRetry }) {
  return (
    <div role="alert" className="rounded-2xl border border-rose-200 bg-rose-50 p-5">
      <p className="text-sm font-semibold text-rose-800">Something went wrong</p>
      <p className="mt-1 text-sm text-rose-700">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 rounded-lg border border-rose-300 bg-white px-3 py-1.5 text-sm font-semibold text-rose-700 hover:bg-rose-100"
        >
          Try again
        </button>
      )}
    </div>
  )
}

export function LoadingState({ label = 'Loading jobs' }) {
  return (
    <div role="status" className="space-y-3">
      <span className="sr-only">{label}</span>
      {[1, 2, 3].map((item) => (
        <div key={item} className="h-14 animate-pulse rounded-xl bg-slate-100" />
      ))}
    </div>
  )
}

export function EmptyState({ title, description, action }) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-14 text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-2xl bg-indigo-50 text-xl text-indigo-600">
        ◇
      </div>
      <h3 className="mt-4 font-semibold text-slate-900">{title}</h3>
      <p className="mx-auto mt-1 max-w-md text-sm leading-6 text-slate-500">{description}</p>
      {action}
    </div>
  )
}
