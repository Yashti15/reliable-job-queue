import { useEffect, useState } from 'react'
import { getHealth } from './api/jobs.js'
import { DashboardPage } from './pages/DashboardPage.jsx'
import { JobsPage } from './pages/JobsPage.jsx'
import { CreateJobPage } from './pages/CreateJobPage.jsx'
import { DeadJobsPage } from './pages/DeadJobsPage.jsx'
import { JobDetailsPage } from './pages/JobDetailsPage.jsx'
import { AppShell } from './components/AppShell.jsx'
import { useQueueRealtime } from './realtime/RealtimeProvider.jsx'
import { RealtimeProvider } from './realtime/RealtimeProvider.jsx'
import { ToastProvider } from './components/Toast.jsx'
import { AuthPage } from './pages/AuthPage.jsx'
import { useAuth } from './auth/AuthProvider.jsx'

function useLocation() {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
  }))

  useEffect(() => {
    const updateLocation = () =>
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
      })
    window.addEventListener('popstate', updateLocation)
    window.addEventListener('app:navigate', updateLocation)
    return () => {
      window.removeEventListener('popstate', updateLocation)
      window.removeEventListener('app:navigate', updateLocation)
    }
  }, [])

  return location
}

function DashboardApplication({ location, health, user, onLogout }) {
  const { connectionState } = useQueueRealtime()
  const page = location.pathname.match(/^\/jobs\/([^/]+)$/)
    ? <JobDetailsPage jobId={decodeURIComponent(location.pathname.split('/').pop())} />
    : location.pathname === '/jobs'
      ? <JobsPage search={location.search} />
      : location.pathname === '/create'
        ? <CreateJobPage />
        : location.pathname === '/dead'
          ? <DeadJobsPage />
          : <DashboardPage />

  return (
    <AppShell health={health} connectionState={connectionState} user={user} onLogout={onLogout}>
      <ToastProvider>
        {page}
      </ToastProvider>
    </AppShell>
  )
}

function App() {
  const location = useLocation()
  const { user, loading, logout, sessionError, retrySession } = useAuth()
  const [health, setHealth] = useState({ loading: true, connected: false })
  useEffect(() => {
    let active = true
    getHealth()
      .then(({ data }) => {
        if (active) {
          setHealth({
            loading: false,
            connected: data?.status === 'ok' && data?.database === 'connected',
          })
        }
      })
      .catch(() => {
        if (active) {
          setHealth({ loading: false, connected: false })
        }
      })

    return () => {
      active = false
    }
  }, [])

  if (loading) {
    return <main className="grid min-h-screen place-items-center text-sm font-medium text-slate-500">Restoring your secure session…</main>
  }
  if (!user) {
    if (sessionError) {
      return (
        <main className="grid min-h-screen place-items-center bg-[#f5f7fb] px-4">
          <section className="max-w-md rounded-2xl border border-rose-200 bg-white p-7 shadow-lg">
            <h1 className="text-lg font-bold text-slate-950">Session could not be checked</h1>
            <p role="alert" className="mt-2 text-sm text-rose-800">{sessionError}</p>
            <button
              type="button"
              onClick={retrySession}
              className="mt-5 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Retry connection
            </button>
          </section>
        </main>
      )
    }
    return <AuthPage mode={location.pathname === '/register' ? 'register' : 'login'} />
  }

  return (
    <RealtimeProvider key={user.id}>
      <DashboardApplication location={location} health={health} user={user} onLogout={logout} />
    </RealtimeProvider>
  )
}

export default App
