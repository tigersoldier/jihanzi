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
  getLogsAfter,
  getLatestSnapshot,
  getLastSyncTime,
  setLastSyncTime,
  saveCurrentSnapshot,
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

// Debounce timer for notifyDataChanged — batched pushes.
let notifyTimer: ReturnType<typeof setTimeout> | null = null

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
 * Notify that local data has changed — triggers a debounced push to Drive.
 * Call after any local mutation that should be synced.
 *
 * Debounced: rapid-fire mutations within 2s are batched into one push.
 */
export function notifyDataChanged(): void {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    pushChanges().catch(() => {
      // Silently ignore — will be picked up by next background sync
    })
  }, 2000) // 2s debounce
}

/**
 * Initial data pull from Google Drive on first load.
 * Merges remote data with local data and saves to IndexedDB.
 *
 * Merge strategy (append-only log ⇒ conflict-free):
 * 1. Parse snapshot and log entries from every child folder on Drive.
 * 2. Pick the newest snapshot (by timestamp) across local and remote.
 * 3. Union all log entries — duplicate detection by (timestamp, type, entityId)
 *    since log entries are immutable, union is naturally conflict-free.
 * 4. Save the merged result to local IndexedDB.
 *
 * @returns true if remote data was found and merged into local DB.
 */
export async function initialPull(): Promise<boolean> {
  if (!hasValidToken()) {
    setSyncStatus('offline')
    return false
  }

  setSyncStatus('syncing')

  try {
    const { childData } = await pullAllData()

    // Parse remote snapshots and log entries from all child folders
    let remoteSnapshot: Snapshot | null = null
    const remoteLogEntries: AnyLogEntry[] = []

    for (const [, data] of Object.entries(childData)) {
      if (data.snapshot) {
        try {
          const parsed = JSON.parse(data.snapshot)
          if (parsed.state && parsed.timestamp !== undefined) {
            if (!remoteSnapshot || parsed.timestamp > remoteSnapshot.timestamp) {
              remoteSnapshot = parsed as Snapshot
            }
          }
        } catch {
          console.warn('Failed to parse remote snapshot')
        }
      }
      if (data.logs) {
        for (const line of data.logs) {
          try {
            const parsed = JSON.parse(line)
            // Strip Dexie auto-increment 'id' — it's a DB artifact, not a
            // domain value. If passed to appendLogs → bulkAdd, Dexie tries
            // to insert with that primary key and throws ConstraintError
            // when the id already exists in local IndexedDB.
            delete parsed.id
            remoteLogEntries.push(parsed as AnyLogEntry)
          } catch {
            console.warn('Failed to parse remote log line')
          }
        }
      }
    }

    // Nothing to merge — Drive is empty
    if (!remoteSnapshot && remoteLogEntries.length === 0) {
      setSyncStatus('online')
      return false
    }

    // Read local data for merge
    const localSnapshot = await getLatestSnapshot()

    // Pick the newer snapshot
    const bestSnapshot =
      !localSnapshot || (remoteSnapshot && remoteSnapshot.timestamp > localSnapshot.timestamp)
        ? remoteSnapshot
        : localSnapshot

    if (bestSnapshot && bestSnapshot !== localSnapshot) {
      await saveCurrentSnapshot({ timestamp: bestSnapshot.timestamp, state: bestSnapshot.state })
    }

    // Filter: only keep remote log entries with timestamp > local snapshot timestamp.
    // Entries already materialised in the snapshot are redundant.
    const cutoff = bestSnapshot ? bestSnapshot.timestamp : 0
    const newEntries = remoteLogEntries.filter(e => e.timestamp > cutoff)

    if (newEntries.length > 0) {
      // Sort by timestamp so log replay is chronological
      newEntries.sort((a, b) => a.timestamp - b.timestamp)
      await appendLogs(newEntries)
    }

    setSyncStatus('online')
    return true
  } catch (err) {
    console.error('Sync pull failed:', err)
    setSyncStatus('error')
    return false
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
    // Only push log entries created since the last successful sync.
    const lastSync = await getLastSyncTime()
    const logs = await getLogsAfter(lastSync)
    const snapshot = await getLatestSnapshot()

    // Ensure Drive folder structure exists
    const rootId = await findOrCreateRootFolder()

    // Push metadata
    const metaFile = await findFile(rootId, 'app_meta.json')
    await pushMeta(rootId, {
      lastSyncTime: Date.now(),
      version: '0.1.0',
    }, metaFile?.id)

    // Push per-child snapshot + logs
    const snapshotData = JSON.stringify(snapshot)

    if (snapshot && logs.length > 0) {
      for (const child of snapshot.state.children) {
        const childFolderId = await findOrCreateFolder(rootId, child.name)
        const snapshotFile = await findFile(childFolderId, 'snapshot.json')
        const logFile = await findFile(childFolderId, 'log.jsonl')

        await pushSnapshot(childFolderId, snapshotData, snapshotFile?.id)
        const logLines = logs.map((l: any) => JSON.stringify(l))
        await pushLogs(childFolderId, logLines, logFile?.id)
      }
    }

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
