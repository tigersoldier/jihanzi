import { createContext, useContext } from 'react'
import type { SyncStatus } from '../data/sync'

export interface SyncContextState {
  status: SyncStatus
  lastSyncTime: number | null
  /** 登录后首次拉取是否仍在进行（含拉取启动前的异步间隙） */
  initialSyncPending: boolean
  syncNow: () => Promise<void>
}

export const SyncContext = createContext<SyncContextState | null>(null)

export function useSync(): SyncContextState {
  const context = useContext(SyncContext)
  if (!context) {
    throw new Error('useSync must be used within a SyncProvider')
  }
  return context
}
