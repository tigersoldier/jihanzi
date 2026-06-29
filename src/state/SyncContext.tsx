import {
  createContext,
  useContext,
  useState,
  useEffect,
  type ReactNode,
} from 'react'
import type { SyncStatus } from '../data/sync'
import {
  getSyncStatus,
  onSyncStatusChange,
  startBackgroundSync,
  stopBackgroundSync,
  checkOnlineStatus,
  pushChanges,
  initialPull,
} from '../data/sync'
import { useAuth } from './AuthContext'

interface SyncContextState {
  status: SyncStatus
  lastSyncTime: number | null
  syncNow: () => Promise<void>
}

const SyncContext = createContext<SyncContextState | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useAuth()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null)

  useEffect(() => {
    const unsubscribe = onSyncStatusChange(setStatus)
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    // Initial pull from Drive
    initialPull().then(() => {
      setLastSyncTime(Date.now())
    })

    // Start background sync
    startBackgroundSync()

    // Listen for online/offline events
    window.addEventListener('online', checkOnlineStatus)
    window.addEventListener('offline', checkOnlineStatus)
    checkOnlineStatus()

    return () => {
      stopBackgroundSync()
      window.removeEventListener('online', checkOnlineStatus)
      window.removeEventListener('offline', checkOnlineStatus)
    }
  }, [isLoggedIn])

  const syncNow = async () => {
    await pushChanges()
    await initialPull()
    setLastSyncTime(Date.now())
  }

  return (
    <SyncContext.Provider value={{ status, lastSyncTime, syncNow }}>
      {children}
    </SyncContext.Provider>
  )
}

export function useSync(): SyncContextState {
  const context = useContext(SyncContext)
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return context
}
