import { createContext, useContext, useState, useCallback } from 'react'

const ToastContext = createContext({
  showToast: () => {},
})

export function useToast() {
  return useContext(ToastContext)
}

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const showToast = useCallback((message, type = 'success', durationMs = 4000) => {
    const id = Date.now() + Math.random().toString(36).slice(2, 7)
    setToasts((prev) => [...prev, { id, message, type }])
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id))
    }, durationMs)
  }, [])

  const removeToast = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2 max-w-sm w-full px-4"
      >
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="status"
            className={`pointer-events-auto flex items-start justify-between gap-3 rounded-xl border p-4 shadow-lg transition-all ${
              toast.type === 'error'
                ? 'border-rose-200 bg-rose-50 text-rose-900'
                : toast.type === 'info'
                  ? 'border-sky-200 bg-sky-50 text-sky-900'
                  : 'border-emerald-200 bg-emerald-50 text-emerald-900'
            }`}
          >
            <div className="flex-1 text-xs font-medium leading-relaxed">
              {toast.message}
            </div>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              className="text-xs opacity-60 hover:opacity-100"
              aria-label="Close notification"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
