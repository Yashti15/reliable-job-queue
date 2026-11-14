import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { io } from 'socket.io-client'
import { getSocketOrigin } from '../api/jobs.js'

const RealtimeContext = createContext({
  connectionState: 'connecting',
  jobRefreshVersion: 0,
  workerRefreshVersion: 0,
})

const lifecycleEvents = [
  'job:created',
  'job:claimed',
  'job:completed',
  'job:failed',
  'job:retried',
  'job:dead',
  'job:replayed',
  'job:cancelled',
  'worker:updated',
  'worker:heartbeat',
]

export function RealtimeProvider({ children }) {
  const [connectionState, setConnectionState] = useState('connecting')
  const [jobRefreshVersion, setJobRefreshVersion] = useState(0)
  const [workerRefreshVersion, setWorkerRefreshVersion] = useState(0)

  useEffect(() => {
    const socket = io(getSocketOrigin(), { autoConnect: false, withCredentials: true })
    const refreshJobs = () => setJobRefreshVersion((version) => version + 1)
    const refreshWorkers = () => setWorkerRefreshVersion((version) => version + 1)
    const onConnect = () => {
      setConnectionState('connected')
      refreshJobs()
      refreshWorkers()
    }
    const onDisconnect = () => setConnectionState('reconnecting')
    const onReconnectAttempt = () => setConnectionState('reconnecting')
    const onConnectError = () => setConnectionState('reconnecting')

    socket.on('connect', onConnect)
    socket.on('disconnect', onDisconnect)
    socket.on('connect_error', onConnectError)
    socket.io.on('reconnect_attempt', onReconnectAttempt)
    lifecycleEvents.forEach((eventName) =>
      socket.on(
        eventName,
        eventName.startsWith('worker:') ? refreshWorkers : refreshJobs,
      ),
    )
    socket.connect()

    return () => {
      socket.off('connect', onConnect)
      socket.off('disconnect', onDisconnect)
      socket.off('connect_error', onConnectError)
      socket.io.off('reconnect_attempt', onReconnectAttempt)
      lifecycleEvents.forEach((eventName) =>
        socket.off(
          eventName,
          eventName.startsWith('worker:') ? refreshWorkers : refreshJobs,
        ),
      )
      socket.disconnect()
    }
  }, [])

  const value = useMemo(
    () => ({ connectionState, jobRefreshVersion, workerRefreshVersion }),
    [connectionState, jobRefreshVersion, workerRefreshVersion],
  )

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>
}

export function useQueueRealtime() {
  return useContext(RealtimeContext)
}
