import { useEffect, useState } from 'react'
import axios from 'axios'

const initialHealth = { state: 'checking', database: 'unknown' }

function App() {
  const [health, setHealth] = useState(initialHealth)

  useEffect(() => {
    let active = true

    axios
      .get('/api/health')
      .then(({ data }) => {
        if (active) {
          setHealth({ state: data.status, database: data.database })
        }
      })
      .catch(() => {
        if (active) {
          setHealth({ state: 'unavailable', database: 'unknown' })
        }
      })

    return () => {
      active = false
    }
  }, [])

  const apiIsOnline = health.state === 'ok'

  return (
    <main className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto max-w-4xl">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-cyan-400">
          Learning project · Day 1
        </p>
        <h1 className="mt-4 text-4xl font-bold tracking-tight sm:text-5xl">
          Reliable Job Queue
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-8 text-slate-300">
          A MongoDB-backed queue built from first principles, with worker
          recovery and dead-letter handling on the roadmap.
        </p>

        <section
          aria-labelledby="health-heading"
          className="mt-10 rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl"
        >
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h2 id="health-heading" className="text-xl font-semibold">
                Service health
              </h2>
              <p className="mt-1 text-sm text-slate-400">
                Live check from the Express API
              </p>
            </div>
            <span
              className={`rounded-full px-3 py-1 text-sm font-medium ${
                apiIsOnline
                  ? 'bg-emerald-400/10 text-emerald-300'
                  : 'bg-amber-400/10 text-amber-300'
              }`}
            >
              API: {health.state}
            </span>
          </div>
          <p className="mt-5 text-slate-300">
            MongoDB: <span className="font-medium text-white">{health.database}</span>
          </p>
          {!apiIsOnline && health.state !== 'checking' && (
            <p role="status" className="mt-3 text-sm text-amber-200">
              Start the API server to load its health status.
            </p>
          )}
        </section>

        <section className="mt-8">
          <h2 className="text-lg font-semibold">Build roadmap</h2>
          <p className="mt-2 text-slate-400">
            Queue processing and job metrics are not available yet. We will add
            them incrementally and verify each module before marking it done.
          </p>
        </section>
      </div>
    </main>
  )
}

export default App

