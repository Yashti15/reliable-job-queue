import { useState } from 'react'
import { AppLink, navigate } from '../components/AppLink.jsx'
import { useAuth } from '../auth/AuthProvider.jsx'
import { getApiErrorMessage } from '../api/jobs.js'

export function AuthPage({ mode = 'login' }) {
  const isRegister = mode === 'register'
  const { login, register } = useAuth()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      if (isRegister) {
        await register({ name, email, password })
      } else {
        await login({ email, password })
      }
      navigate('/')
    } catch (requestError) {
      setError(getApiErrorMessage(requestError))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="grid min-h-screen place-items-center bg-[#f5f7fb] px-4 py-10">
      <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/50 sm:p-9">
        <div className="mb-8 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-xl bg-indigo-600 text-lg font-bold text-white">rq</div>
          <div>
            <p className="font-bold tracking-tight text-slate-950">QueueOps</p>
            <p className="text-xs text-slate-500">Secure job management</p>
          </div>
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-950">
          {isRegister ? 'Create your account' : 'Welcome back'}
        </h1>
        <p className="mt-2 text-sm text-slate-500">
          {isRegister ? 'Set up a private workspace for your jobs.' : 'Sign in to your job queue workspace.'}
        </p>

        {error && <p role="alert" className="mt-5 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">{error}</p>}

        <form className="mt-6 space-y-4" onSubmit={submit}>
          {isRegister && (
            <label className="block text-xs font-semibold text-slate-600">
              Name
              <input required maxLength={100} autoComplete="name" value={name} onChange={(event) => setName(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
            </label>
          )}
          <label className="block text-xs font-semibold text-slate-600">
            Email
            <input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
          </label>
          <label className="block text-xs font-semibold text-slate-600">
            Password
            <input required type="password" minLength={isRegister ? 12 : undefined} autoComplete={isRegister ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2.5 text-sm font-normal text-slate-800 outline-none focus:border-indigo-400 focus:ring-4 focus:ring-indigo-100" />
            {isRegister && <span className="mt-1 block text-[11px] font-normal text-slate-400">Use at least 12 characters (maximum 72 UTF-8 bytes).</span>}
          </label>
          <button type="submit" disabled={busy} className="w-full rounded-xl bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-sm shadow-indigo-200 hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in'}
          </button>
        </form>

        <p className="mt-6 text-center text-sm text-slate-500">
          {isRegister ? 'Already registered?' : 'New to QueueOps?'}{' '}
          <AppLink href={isRegister ? '/login' : '/register'} className="font-semibold text-indigo-700 hover:text-indigo-900">
            {isRegister ? 'Sign in' : 'Create an account'}
          </AppLink>
        </p>
      </section>
    </main>
  )
}
