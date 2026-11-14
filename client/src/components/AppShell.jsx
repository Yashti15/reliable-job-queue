import { useState } from 'react'
import { AppLink } from './AppLink.jsx'

const navigation = [
  { href: '/', label: 'Overview', symbol: '◫' },
  { href: '/jobs', label: 'All jobs', symbol: '▤' },
  { href: '/create', label: 'Create job', symbol: '+' },
  { href: '/dead', label: 'Dead letter queue', symbol: '⌁' },
]

export function AppShell({ health, connectionState, user, onLogout, children }) {
  const [menuOpen, setMenuOpen] = useState(false)
  const pathname = window.location.pathname

  return (
    <div className="min-h-screen bg-[#f5f7fb] text-slate-900">
      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:translate-x-0 ${
          menuOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-20 items-center gap-3 border-b border-slate-100 px-6">
          <div className="grid size-10 place-items-center rounded-xl bg-indigo-600 text-lg font-bold text-white shadow-sm shadow-indigo-200">
            rq
          </div>
          <div>
            <p className="font-bold tracking-tight text-slate-950">QueueOps</p>
            <p className="text-xs text-slate-500">Job management</p>
          </div>
          <button
            type="button"
            className="ml-auto rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="px-4 pt-7">
          <p className="px-3 text-[11px] font-bold uppercase tracking-[0.16em] text-slate-400">
            Workspace
          </p>
          <nav className="mt-3 space-y-1" aria-label="Main navigation">
            {navigation.map((item) => (
              <AppLink
                key={item.href}
                href={item.href}
                onNavigate={() => setMenuOpen(false)}
                aria-current={
                  pathname === item.href ||
                  (item.href === '/jobs' && /^\/jobs\/[^/]+$/.test(pathname))
                    ? 'page'
                    : undefined
                }
                className={`group flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${
                  pathname === item.href ||
                  (item.href === '/jobs' && /^\/jobs\/[^/]+$/.test(pathname))
                    ? 'bg-indigo-50 text-indigo-700'
                    : 'text-slate-600 hover:bg-indigo-50 hover:text-indigo-700'
                }`}
              >
                <span className="grid size-7 place-items-center rounded-lg bg-slate-100 text-base text-slate-500 group-hover:bg-white group-hover:text-indigo-600">
                  {item.symbol}
                </span>
                {item.label}
                {item.href === '/dead' && (
                  <span className="ml-auto rounded-md bg-rose-50 px-2 py-0.5 text-[10px] font-semibold text-rose-600">
                    DLQ
                  </span>
                )}
              </AppLink>
            ))}
          </nav>
        </div>

        <div className="mt-auto border-t border-slate-100 p-5">
          <div className="rounded-2xl bg-slate-50 p-4">
            <div className="flex items-center gap-2">
              <span
                className={`size-2 rounded-full ${
                  health.loading
                    ? 'animate-pulse bg-amber-400'
                    : health.connected
                      ? 'bg-emerald-500'
                      : 'bg-rose-500'
                }`}
              />
              <p className="text-xs font-semibold text-slate-700">
                {health.loading ? 'Checking services' : health.connected ? 'API connected' : 'API unavailable'}
              </p>
            </div>
            <p className="mt-2 text-[11px] leading-5 text-slate-500">
              {health.connected
                ? 'Queue data is being served by your backend.'
                : 'Start the API to load live queue data.'}
            </p>
          </div>
          <p className="mt-4 text-[11px] text-slate-400">Reliable Job Queue · v0.1</p>
        </div>
      </aside>

      {menuOpen && (
        <button
          type="button"
          aria-label="Close navigation overlay"
          className="fixed inset-0 z-20 bg-slate-950/30 lg:hidden"
          onClick={() => setMenuOpen(false)}
        />
      )}

      <div className="min-h-screen lg:pl-64">
        <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-slate-200/80 bg-white/90 px-4 backdrop-blur md:px-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              aria-label="Open navigation"
              className="rounded-lg border border-slate-200 p-2 text-slate-600 lg:hidden"
              onClick={() => setMenuOpen(true)}
            >
              ☰
            </button>
            <p className="text-sm font-medium text-slate-500">Queue operations</p>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-slate-500 sm:inline">MongoDB-backed queue</span>
            <span className="flex items-center gap-2 rounded-full bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-600" aria-live="polite">
              <span className={`size-2 rounded-full ${connectionState === 'connected' ? 'bg-emerald-500' : 'animate-pulse bg-amber-400'}`} />
              {connectionState === 'connected' ? 'Live updates on' : 'Reconnecting'}
            </span>
            <div className="hidden text-right sm:block">
              <p className="text-xs font-semibold text-slate-800">{user.name}</p>
              <p className="text-[10px] text-slate-500">{user.email}</p>
            </div>
            <button type="button" onClick={onLogout} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Sign out
            </button>
          </div>
        </header>
        <main className="mx-auto max-w-[1440px] px-4 py-7 md:px-8 md:py-9">{children}</main>
      </div>
    </div>
  )
}
