import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  getApiErrorMessage,
  getCurrentUser,
  getCsrfToken,
  loginAccount,
  logoutAccount,
  registerAccount,
} from '../api/jobs.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [sessionError, setSessionError] = useState('')
  const [retryCount, setRetryCount] = useState(0)

  const clearSession = useCallback(() => setUser(null), [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setSessionError('')
    getCurrentUser()
      .then(({ data }) => {
        if (active) setUser(data.data.user)
      })
      .catch((error) => {
        if (active) {
          setUser(null)
          if (error?.response?.status !== 401) {
            setSessionError(getApiErrorMessage(error))
          }
        }
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    window.addEventListener('auth:unauthorized', clearSession)
    return () => {
      active = false
      window.removeEventListener('auth:unauthorized', clearSession)
    }
  }, [clearSession, retryCount])

  const login = useCallback(async (credentials) => {
    await getCsrfToken()
    const { data } = await loginAccount(credentials)
    setSessionError('')
    setUser(data.data.user)
  }, [])

  const register = useCallback(async (details) => {
    await getCsrfToken()
    const { data } = await registerAccount(details)
    setSessionError('')
    setUser(data.data.user)
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutAccount()
    } catch (error) {
      if (error?.response?.status !== 401) throw new Error(getApiErrorMessage(error))
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      sessionError,
      retrySession: () => setRetryCount((count) => count + 1),
      login,
      register,
      logout,
    }),
    [user, loading, sessionError, login, register, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) throw new Error('useAuth must be used within AuthProvider.')
  return context
}
