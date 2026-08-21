import { createContext, useContext, useState, useEffect, type ReactNode } from 'react'
import type { SyncStatus } from '../data/sync'
import {
  onSyncStatusChange,
  startBackgroundSync,
  stopBackgroundSync,
  checkOnlineStatus,
  syncOnce,
  initialPull,
  ensureIntervalFilesOnDrive,
  repairPollutedData,
} from '../data/sync'
import { useAuth } from './AuthContext'
import { useApp } from './AppContext'
import { getLastKnownRemoteTime } from '../data/db'

interface SyncContextState {
  status: SyncStatus
  lastSyncTime: number | null
  /** 登录后首次拉取是否仍在进行（含拉取启动前的异步间隙） */
  initialSyncPending: boolean
  syncNow: () => Promise<void>
}

const SyncContext = createContext<SyncContextState | null>(null)

export function SyncProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useAuth()
  const { reloadState } = useApp()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [lastSyncTime, setLastSyncTime] = useState<number | null>(null)
  // 登录后首次拉取进行中：从 effect 同步置 true 起，到拉取 settle 为止。
  // 首页据此在首次拉取期间禁止开始学习——拉取中的任务队列尚未合并远程变更。
  const [initialSyncPending, setInitialSyncPending] = useState(false)

  useEffect(() => {
    const unsubscribe = onSyncStatusChange(setStatus)
    return unsubscribe
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    // 同步置位：覆盖 getLastKnownRemoteTime 到 initialPull 置 'syncing' 之间的间隙——
    // 这期间本地旧快照已渲染、首页按钮可用，若不加挂起标记会漏过首次拉取的门控。
    setInitialSyncPending(true)

    // Initial pull from Drive — if remote data was merged into
    // IndexedDB, tell AppContext to reload so the UI picks it up.
    // 先获取 lastKnownRemoteTime 做增量拉取（0 或 undefined → 全量）
    getLastKnownRemoteTime()
      .then(remoteTime => initialPull(remoteTime))
      .then(pullResult => {
        setLastSyncTime(Date.now())
        if (pullResult.didMerge) {
          reloadState()
        }
        // Ensure Drive has all local interval files (startup check only)
        ensureIntervalFilesOnDrive().catch(() => {})
        // 修复历史同步 bug 遗留的日志重复与快照污染（启动时执行一次）
        repairPollutedData()
          .then(r => {
            if (r.snapshotRepaired) reloadState()
          })
          .catch(() => {})
      })
      // 拉取失败也解除挂起——离线/失败时本地数据即最新可用数据，允许开始学习
      .catch(() => {})
      .finally(() => setInitialSyncPending(false))

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
    const didMerge = await syncOnce()
    if (didMerge) {
      reloadState()
    }
    setLastSyncTime(Date.now())
  }

  return (
    <SyncContext.Provider value={{ status, lastSyncTime, initialSyncPending, syncNow }}>
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
