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
  syncOnce,
  initialPull,
  ensureIntervalFilesOnDrive,
} from '../data/sync'
import { useAuth } from './AuthContext'
import { useApp } from './AppContext'
import { getLastKnownRemoteTime } from '../data/db'

interface SyncContextState {
  status: SyncStatus
  lastSyncTime: number | null
  syncNow: () => Promise<void>
}

const SyncContext = createContext<SyncContextState | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useAuth()
  const { reloadState } = useApp()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null)

  useEffect(() => {
    const unsubscribe = onSyncStatusChange(setStatus)
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    // Initial pull from Drive — if remote data was merged into
    // IndexedDB, tell AppContext to reload so the UI picks it up.
    // 先获取 lastKnownRemoteTime 做增量拉取（0 或 undefined → 全量）
    getLastKnownRemoteTime().then(remoteTime =>
      initialPull(remoteTime)
    ).then((pullResult) => {
      setLastSyncTime(Date.now())
      if (pullResult.didMerge) {
        reloadState()
      }
      // Ensure Drive has all local interval files (startup check only)
      ensureIntervalFilesOnDrive().catch(() => {})
    })

    // Start background sync
    startBackgroundSync(() => {
      reloadState()
      setLastSyncTime(Date.now())
    })

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
    await syncOnce()
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
