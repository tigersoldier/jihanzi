/**
 * Sync Orchestrator
 *
 * Pull-diff-push protocol:
 * 1. Pull: listFiles(modifiedTime > lastKnownRemoteTime) → read changed files
 * 2. Diff: (timestamp, type, entityId) content-based dedup → { remoteOnly, localOnly }
 * 3. Push: localOnly → interval-based log files + snapshot_current.json
 * 4. Update: lastKnownRemoteTime = max(Drive modifiedTime)
 */

import type { AnyLogEntry, Snapshot } from '../core/types'
import { applyEntry, deepCloneState } from '../core/log'
import {
  appendLogs,
  getLogsAfter,
  getLatestSnapshot,
  setLastKnownRemoteTime,
  saveCurrentSnapshot,
  getHistoricalSnapshots,
  getLogTimestampRange,
  getLogsAfterPaginated,
  getLastKnownRemoteTime,
} from './db'
import {
  findOrCreateRootFolder,
  findOrCreateFolder,
  findFile,
  listFiles,
  pullAllData,
  pushMeta,
  pushSnapshot,
  pushLogs,
  logFileName,
  snapshotFileName,
} from './drive'
import { getIntervalKey, getIntervalKeysBetween } from '../utils/date'
import { makeDiffKey } from '../utils/logKey'
import { hasValidToken } from './gapi'

// ============================================================
// Diff — content-based log dedup
// ============================================================

/** Clock-skew buffer: widen the candidate window by 1 hour for content dedup */
const CLOCK_SKEW_BUFFER = 60 * 60 * 1000

/** Batch size for paginated log scans — odd number ensures batch boundaries are visible */
const SCAN_BATCH_SIZE = 501

/**
 * Diff two log entry collections by content (not timestamp range).
 * Returns entries that only exist in one collection but not the other.
 */
export function diffEntries(
  local: AnyLogEntry[],
  remote: AnyLogEntry[],
): { remoteOnly: AnyLogEntry[]; localOnly: AnyLogEntry[] } {
  const remoteKeys = new Set(remote.map(makeDiffKey))
  const localKeys = new Set(local.map(makeDiffKey))

  const remoteOnly = remote.filter(e => !localKeys.has(makeDiffKey(e)))
  const localOnly = local.filter(e => !remoteKeys.has(makeDiffKey(e)))

  return { remoteOnly, localOnly }
}

// ============================================================
// State & status
// ============================================================

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
 * Notify that local data has changed — triggers a debounced sync to Drive.
 * Debounced: rapid-fire mutations within 2s are batched into one sync cycle.
 */
export function notifyDataChanged(): void {
  if (notifyTimer) clearTimeout(notifyTimer)
  notifyTimer = setTimeout(() => {
    notifyTimer = null
    syncOnce().catch(() => {
      // Silently ignore — will be picked up by next background sync
    })
  }, 2000)
}

// ============================================================
// Pull
// ============================================================

/** Result of a pull operation — used by syncOnce for diff & push decisions */
interface PullResult {
  /** Whether remote data was found and merged into local DB */
  didMerge: boolean
  /** Whether Drive has no data at all */
  driveIsEmpty: boolean
  /** Parsed remote snapshot (best one across child folders), or null */
  remoteSnapshot: Snapshot | null
  /** Parsed remote log entries (from all interval-based log files) */
  remoteLogEntries: AnyLogEntry[]
}

/**
 * Pull data from Google Drive and merge into local IndexedDB.
 *
 * Only reads files with modifiedTime > lastKnownRemoteTime.
 * Returns structured result for the diff/push decision in syncOnce.
 */
export async function initialPull(lastKnownRemoteTime?: number): Promise<PullResult> {
  if (!hasValidToken()) {
    setSyncStatus('offline')
    return { didMerge: false, driveIsEmpty: true, remoteSnapshot: null, remoteLogEntries: [] }
  }

  setSyncStatus('syncing')

  try {
    // 增量拉取：只读取 modifiedTime > lastKnownRemoteTime 的文件
    // lastKnownRemoteTime 为 0 或 undefined 时走全量拉取（首次同步/清除数据）
    const modifiedAfter = lastKnownRemoteTime && lastKnownRemoteTime > 0
      ? new Date(lastKnownRemoteTime).toISOString()
      : undefined
    const { childData } = await pullAllData(modifiedAfter)

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
            delete parsed.id  // Strip Dexie auto-increment id
            remoteLogEntries.push(parsed as AnyLogEntry)
          } catch {
            console.warn('Failed to parse remote log line')
          }
        }
      }
    }

    // Drive is empty — but only if we didn't filter by modifiedAfter.
    // When modifiedAfter is set and child folders exist (but no files matched the filter),
    // Drive is not empty — it's just that nothing changed remotely.
    if (!remoteSnapshot && remoteLogEntries.length === 0) {
      const hasChildFolders = Object.keys(childData).length > 0
      setSyncStatus('online')
      return {
        didMerge: false,
        driveIsEmpty: !modifiedAfter && !hasChildFolders,
        remoteSnapshot: null,
        remoteLogEntries: [],
      }
    }

    // Merge snapshot: pick the newer one by timestamp
    const localSnapshot = await getLatestSnapshot()
    const bestSnapshot =
      !localSnapshot || (remoteSnapshot && remoteSnapshot.timestamp > localSnapshot.timestamp)
        ? remoteSnapshot
        : localSnapshot

    if (bestSnapshot && bestSnapshot !== localSnapshot) {
      await saveCurrentSnapshot({ timestamp: bestSnapshot.timestamp, state: bestSnapshot.state })
    }

    // Diff logs by content (not timestamp range) to avoid clock-skew data loss.
    // 使用远程批次中最早条目的 timestamp 作为候选窗口下限，确保所有远程条目
    // 都有机会匹配到本地已有条目。clock-skew buffer 防御设备间合理的时间偏差。
    const remoteTMin = remoteLogEntries.reduce(
      (min, e) => Math.min(min, e.timestamp),
      remoteSnapshot?.timestamp ?? Infinity,
    )
    const candidateLowerBound = remoteTMin === Infinity
      ? 0
      : Math.max(0, remoteTMin - CLOCK_SKEW_BUFFER)
    const localCandidateLogs = await getLogsAfter(candidateLowerBound)

    const { remoteOnly } = diffEntries(localCandidateLogs, remoteLogEntries)

    // 内部去重：如果 remoteLogEntries 本身包含重复（如 Drive 文件已有重复行），
    // 只保留每个 diff key 的第一条，避免批量写入重复日志到本地 DB
    const seen = new Set<string>()
    const dedupedRemoteOnly = remoteOnly.filter(e => {
      const key = makeDiffKey(e)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })

    // Append remote-only entries to local IndexedDB
    if (dedupedRemoteOnly.length > 0) {
      dedupedRemoteOnly.sort((a, b) => a.timestamp - b.timestamp)
      await appendLogs(dedupedRemoteOnly)
    }

    // Replay remote-only entries into the snapshot so that in-memory
    // state (SM-2 progress, nextCharIndex, etc.) reflects the merged
    // logs. Without this, the snapshot would be stale after a first
    // import or after pulling reviews produced on another device.
    const hadBestSnapshot = bestSnapshot !== null
    if (hadBestSnapshot && dedupedRemoteOnly.length > 0) {
      const mergedState = deepCloneState(bestSnapshot!.state)
      const sortedRemoteOnly = [...dedupedRemoteOnly].sort((a, b) => a.timestamp - b.timestamp)
      let changed = false
      for (const entry of sortedRemoteOnly) {
        if (applyEntry(mergedState, entry)) changed = true
      }
      if (changed) {
        await saveCurrentSnapshot({ timestamp: Date.now(), state: mergedState })
      }
    }

    setSyncStatus('online')
    return {
      didMerge: dedupedRemoteOnly.length > 0 || (bestSnapshot !== localSnapshot),
      driveIsEmpty: false,
      remoteSnapshot,
      remoteLogEntries,
    }
  } catch (err) {
    console.error('Sync pull failed:', err)
    setSyncStatus('error')
    return { didMerge: false, driveIsEmpty: false, remoteSnapshot: null, remoteLogEntries: [] }
  }
}

// ============================================================
// Push
// ============================================================

/**
 * Push log entries + current snapshot to Drive.
 * Exported for direct use by syncOnce and for testing.
 */
export async function pushChanges(
  logEntries: AnyLogEntry[],
  snapshot: Snapshot,
): Promise<void> {
  const rootId = await findOrCreateRootFolder()

  // Push metadata
  const metaFile = await findFile(rootId, 'app_meta.json')
  await pushMeta(rootId, {
    lastKnownRemoteTime: Date.now(),
    version: '0.1.0',
  }, metaFile?.id)

  const snapshotData = JSON.stringify(snapshot)

  // Group log entries by UTC interval key
  const logsByInterval = new Map<string, AnyLogEntry[]>()
  for (const entry of logEntries) {
    const key = getIntervalKey(entry.timestamp)
    const group = logsByInterval.get(key)
    if (group) {
      group.push(entry)
    } else {
      logsByInterval.set(key, [entry])
    }
  }

  // Load historical snapshots for push
  const historical = logEntries.length > 0
    ? await getHistoricalSnapshots()
    : []

  // ---- Push per-child data ----
  for (const child of snapshot.state.children) {
    const childFolderId = await findOrCreateFolder(rootId, child.name)

    // Push current snapshot
    const snapshotFile = await findFile(childFolderId, 'snapshot_current.json')
    await pushSnapshot(childFolderId, snapshotData, snapshotFile?.id)

    // Push logs to interval-based files
    for (const [intervalKey, entries] of logsByInterval) {
      const fileName = logFileName(intervalKey)
      const existing = await findFile(childFolderId, fileName)
      const logLines = entries.map((l: any) => {
        // 去掉 IndexedDB 自增 id → Drive 上不需要存储这个无用的本地 ID
        const { id: _id, ...rest } = l
        return JSON.stringify(rest)
      })
      await pushLogs(childFolderId, logLines, existing?.id, fileName)
    }

    // Push historical snapshots not yet on Drive
    for (const histSnap of historical) {
      const histKey = getIntervalKey(histSnap.timestamp)
      const histFileName = snapshotFileName(histKey)
      const existing = await findFile(childFolderId, histFileName)
      if (!existing) {
        await pushSnapshot(
          childFolderId,
          JSON.stringify(histSnap),
          null,
          histFileName,
        )
      }
    }
  }
}

// ============================================================
// Unified sync cycle
// ============================================================

/**
 * Pull → diff → push: the unified sync cycle.
 *
 * 1. Pull remote changes (incremental: modifiedTime > lastKnownRemoteTime).
 * 2. Diff by content triples to find local-only entries.
 * 3. Push local-only entries to Drive.
 * 4. Always ensure snapshot_current.json exists (format migration).
 * 5. Update lastKnownRemoteTime from Drive file modifiedTimes.
 */
let syncInProgress = false

export async function syncOnce(): Promise<boolean> {
  if (!hasValidToken()) {
    setSyncStatus('offline')
    return false
  }

  // Prevent concurrent sync cycles from interleaving — multiple triggers
  // (notifyDataChanged debounce, background timer, online event) can fire
  // syncOnce simultaneously, which would cause duplicate log entries.
  if (syncInProgress) return false
  syncInProgress = true

  setSyncStatus('syncing')

  try {
    // 1. Pull remote data（增量：只读取上次同步后变更过的文件）
    const remoteTime = await getLastKnownRemoteTime()
    const pullResult = await initialPull(remoteTime)

    // 2. If Drive is empty, push everything local
    if (pullResult.driveIsEmpty) {
      const snapshot = await getLatestSnapshot()
      if (snapshot) {
        const allLogs = await getLogsAfter(0)
        await pushChanges(allLogs, snapshot)
      }
      // Update lastKnownRemoteTime from Drive
      await refreshLastKnownRemoteTime()
      setSyncStatus('online')
      return false
    }

    // 3. Diff: find local-only entries
    const snapshot = await getLatestSnapshot()
    if (!snapshot) {
      setSyncStatus('online')
      return false
    }

    // 使用远程批次中最早条目的 timestamp 作为候选窗口下限。
    // 当远程无新条目时（增量同步无变更），以 lastKnownRemoteTime 为基准，
    // 避免把已同步的旧条目全部标记为 localOnly。
    const remoteBatchTMin = pullResult.remoteLogEntries.reduce(
      (min, e) => Math.min(min, e.timestamp),
      Infinity,
    )
    let localOnlyLowerBound: number
    if (remoteBatchTMin !== Infinity) {
      // 有远程条目 → 以远程最早条目为基准，减 clock-skew buffer
      localOnlyLowerBound = Math.max(0, remoteBatchTMin - CLOCK_SKEW_BUFFER)
    } else if (!pullResult.driveIsEmpty) {
      // 无远程变更但 Drive 非空 → 以 lastKnownRemoteTime 为基准
      localOnlyLowerBound = Math.max(0, remoteTime - CLOCK_SKEW_BUFFER)
    } else {
      // Drive 为空 → 全量推送（首次同步已在 driveIsEmpty 分支处理）
      localOnlyLowerBound = 0
    }
    const localCandidates = await getLogsAfter(localOnlyLowerBound)

    const { localOnly } = diffEntries(localCandidates, pullResult.remoteLogEntries)

    // 4. Push local-only entries
    if (localOnly.length > 0) {
      await pushChanges(localOnly, snapshot)
    }

    // 5. Always ensure snapshot_current.json exists (format migration)
    if (localOnly.length === 0) {
      const rootId = await findOrCreateRootFolder()
      for (const child of snapshot.state.children) {
        const childFolderId = await findOrCreateFolder(rootId, child.name)
        const existing = await findFile(childFolderId, 'snapshot_current.json')
        if (!existing) {
          await pushSnapshot(childFolderId, JSON.stringify(snapshot), null)
        }
      }
    }

    // 6. Update lastKnownRemoteTime from Drive
    await refreshLastKnownRemoteTime()

    setSyncStatus('online')
    return pullResult.didMerge
  } catch (err) {
    console.error('Sync failed:', err)
    setSyncStatus('error')
    return false
  } finally {
    syncInProgress = false
  }
}

/**
 * Update lastKnownRemoteTime to the latest modifiedTime among
 * all files currently visible on Drive (in the app's folder tree).
 */
async function refreshLastKnownRemoteTime(): Promise<void> {
  try {
    const rootId = await findOrCreateRootFolder()
    const snapshot = await getLatestSnapshot()
    if (!snapshot) return

    let maxTime = 0

    // Check root-level meta file
    const metaFile = await findFile(rootId, 'app_meta.json')
    if (metaFile) {
      const t = new Date(metaFile.modifiedTime).getTime()
      if (t > maxTime) maxTime = t
    }

    // Check per-child file modifiedTimes from Drive (not local clock)
    for (const child of snapshot.state.children) {
      const childFolderId = await findOrCreateFolder(rootId, child.name)
      const files = await listFiles(childFolderId)
      for (const f of files) {
        const t = new Date(f.modifiedTime).getTime()
        if (t > maxTime) maxTime = t
      }
    }

    if (maxTime > 0) {
      await setLastKnownRemoteTime(maxTime)
    }
  } catch (err) {
    console.error('refreshLastKnownRemoteTime failed:', err)
  }
}

// ============================================================
// Startup interval file integrity check
// ============================================================

/**
 * Ensure all local log interval files exist on Drive.
 *
 * Called once at startup after initialPull. Compares the interval range
 * covered by local IndexedDB logs against the interval files present on
 * Drive, and pushes any missing ones in batches.
 *
 * Idempotent: checks file existence via findFile before pushing,
 * and each pushLogs call is atomic (Drive API creates or updates the
 * entire file in one request). Interrupted runs resume cleanly on next
 * startup.
 */
export async function ensureIntervalFilesOnDrive(): Promise<void> {
  try {
    // 1. Determine local interval range
    const { earliest, latest } = await getLogTimestampRange()
    if (earliest === null || latest === null) return

    const snapshot = await getLatestSnapshot()
    if (!snapshot) return

    // 2. Compute all expected local interval keys from the timestamp range
    const allLocalKeys = new Set(getIntervalKeysBetween(earliest, latest))

    // 3. List remote interval files from Drive (union across all children)
    const rootId = await findOrCreateRootFolder()
    const remoteKeys = new Set<string>()
    for (const child of snapshot.state.children) {
      const childFolderId = await findOrCreateFolder(rootId, child.name)
      const files = await listFiles(childFolderId)
      for (const f of files) {
        const match = f.name.match(/^log_(\d{4}-\d{2}-\d{2})\.jsonl$/)
        if (match) remoteKeys.add(match[1])
      }
    }

    // 4. Find missing interval keys (set difference)
    const missingKeys = new Set<string>()
    for (const key of allLocalKeys) {
      if (!remoteKeys.has(key)) missingKeys.add(key)
    }
    if (missingKeys.size === 0) return

    // 5. Single paginated scan: collect entries for missing intervals
    const missingEntries: AnyLogEntry[] = []
    let cursor = earliest
    let afterId: number | undefined

    while (true) {
      const batch = await getLogsAfterPaginated(cursor, SCAN_BATCH_SIZE, afterId)
      if (batch.length === 0) break

      for (const entry of batch) {
        if (missingKeys.has(getIntervalKey(entry.timestamp))) {
          missingEntries.push(entry)
        }
      }

      const lastEntry = batch[batch.length - 1]
      if (lastEntry.timestamp >= latest) break
      cursor = lastEntry.timestamp
      afterId = (lastEntry as any).id as number
    }

    // 6. Push missing interval files
    if (missingEntries.length > 0) {
      await pushChanges(missingEntries, snapshot)
    }
  } catch (err) {
    console.error('Interval file check failed:', err)
  }
}

// ============================================================
// Background sync
// ============================================================

/**
 * Start periodic background sync (every 5 minutes).
 * @param onMerged — called after a sync cycle that merged remote data
 */
export function startBackgroundSync(onMerged?: () => void): void {
  if (syncInterval) return
  syncInterval = setInterval(async () => {
    if (navigator.onLine && hasValidToken()) {
      const didMerge = await syncOnce()
      if (didMerge) onMerged?.()
    }
  }, 5 * 60 * 1000)
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
    syncOnce() // Try to sync when coming back online
  }
}
