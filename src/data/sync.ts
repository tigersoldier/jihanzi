/**
 * Sync Orchestrator
 *
 * Manages synchronization between local IndexedDB and Google Drive:
 * - Pull: Download new data from Drive, merge logs, update local DB
 * - Push: Upload local changes to Drive
 * - Background sync: Periodic sync every 5 minutes
 */

import type { AnyLogEntry, Snapshot } from '../core/types'
import {
  appendLog,
  appendLogs,
  getAllLogs,
  getLatestSnapshot,
  getLastSyncTime,
  setLastSyncTime,
  saveSnapshot,
} from './db'
import {
  findOrCreateRootFolder,
  findOrCreateFolder,
  findFile,
  pullAllData,
  pushMeta,
  pushSnapshot,
  pushLogs,
} from './drive'
import { hasValidToken } from './gapi'

export type SyncStatus = 'idle' | 'syncing' | 'online' | 'offline' | 'error'

let syncStatus: SyncStatus = 'idle'
let syncListeners: Array<(status: SyncStatus) => void> = []
let syncInterval: ReturnType<typeof setInterval> | null = null

/** Subscribe to sync status changes */
export function onSyncStatusChange(listener: (status: SyncStatus) => void): () => void {
  syncListeners.push(listener)
  return () => {
    syncListeners = syncListeners.filter(l => l !== listener)
  }
}

function setSyncStatus(status: SyncStatus): void {
  syncStatus = status
  syncListeners.forEach(l => l(status))
}

/** Get current sync status */
export function getSyncStatus(): SyncStatus {
  return syncStatus
}

/**
 * Initial data pull from Google Drive on first load.
 * Merges remote data with local data.
 */
export async function initialPull(): Promise<void> {
  if (!hasValidToken()) {
    setSyncStatus('offline')
    return
  }

  setSyncStatus('syncing')

  try {
    const { meta, childData } = await pullAllData()

    // TODO: Merge Drive data with local data
    // For now, this is a placeholder. The full merge logic will:
    // 1. Read local logs
    // 2. Parse remote logs from childData
    // 3. Merge by union of timestamps
    // 4. Save merged result back to local DB

    setSyncStatus('online')
  } catch (err) {
    console.error('Sync pull failed:', err)
    setSyncStatus('error')
  }
}

/**
 * Push local changes to Google Drive.
 * Called after each review or edit.
 */
export async function pushChanges(): Promise<void> {
  if (!hasValidToken()) {
    setSyncStatus('offline')
    return
  }

  setSyncStatus('syncing')

  try {
    const logs = await getAllLogs()
    const snapshot = await getLatestSnapshot()

    // Ensure Drive folder structure exists
    const rootId = await findOrCreateRootFolder()

    // Push metadata
    const metaFile = await findFile(rootId, 'app_meta.json')
    await pushMeta(rootId, {
      lastSyncTime: Date.now(),
      version: '0.1.0',
    }, metaFile?.id)

    // For each child, ensure subfolder and push snapshot + logs
    // This is a simplification — full implementation would track per-child
    // Drive file IDs and push incrementally.

    setLastSyncTime(Date.now())
    setSyncStatus('online')
  } catch (err) {
    console.error('Sync push failed:', err)
    setSyncStatus('error')
  }
}

/**
 * Push a single log entry immediately.
 * Called after each user action (review, edit).
 */
export async function pushLogEntry(entry: AnyLogEntry): Promise<void> {
  // Always save locally first
  await appendLog(entry)

  // Try to push to Drive immediately
  if (hasValidToken()) {
    try {
      await pushChanges()
    } catch {
      // Will be picked up by next background sync
    }
  }
}

/**
 * Start periodic background sync (every 5 minutes).
 */
export function startBackgroundSync(): void {
  if (syncInterval) return
  syncInterval = setInterval(async () => {
    if (navigator.onLine && hasValidToken()) {
      await pushChanges()
      await initialPull()
    }
  }, 5 * 60 * 1000) // 5 minutes
}

/**
 * Stop background sync.
 */
export function stopBackgroundSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
  }
}

/**
 * Check online status and update sync state.
 */
export function checkOnlineStatus(): void {
  if (!navigator.onLine) {
    setSyncStatus('offline')
  } else if (syncStatus === 'offline') {
    setSyncStatus('idle')
    pushChanges() // Try to sync when coming back online
  }
}
