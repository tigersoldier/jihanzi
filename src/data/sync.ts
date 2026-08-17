/**
 * Sync Orchestrator
 *
 * Pull-diff-push protocol:
 * 1. Pull: listFiles(modifiedTime > lastKnownRemoteTime) → read changed files
 * 2. Diff: (timestamp, type, entityId) content-based dedup → { remoteOnly, localOnly }
 * 3. Push: localOnly → interval-based log files + snapshot_current.json
 * 4. Update: lastKnownRemoteTime = max(Drive modifiedTime)
 */

import type { AnyLogEntry, AppState, SM2State, Snapshot } from '../core/types'
import { SM2_INITIAL_EASE, SM2_INITIAL_INTERVAL } from '../core/types'
import { applyEntry, deepCloneState } from '../core/log'
import { MAX_SANE_INTERVAL_DAYS, toDateKey } from '../core/sm2'
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
  dedupeLocalLogs,
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
  repairLogFile,
  readFile,
  logFileName,
  snapshotFileName,
} from './drive'
import { getIntervalKey, getIntervalKeysBetween } from '../utils/date'
import { makeDiffKey, dedupeLogEntries } from '../utils/logKey'
import { hasValidToken } from './gapi'

// ============================================================
// 污染检测与状态重建
// ============================================================

/** ease 上限：需要 25+ 次连续 a 评级才能达到，实际使用不可能 */
const MAX_SANE_EASE = 5

const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * 检测快照中的 SM-2 状态是否被污染（重复日志条目被多次应用）。
 *
 * 历史 bug：同步重复追加日志条目后，同一条复习被应用到快照多次，
 * interval 按 ease 指数爆炸（如 1.79e28 天）、nextReview 溢出为
 * "NaN-NaN-NaN"、ease 累积到不可能的高度。
 */
export function isSnapshotPolluted(state: AppState): boolean {
  for (const child of state.children) {
    for (const sm2 of Object.values(child.progress)) {
      if (sm2.interval >= MAX_SANE_INTERVAL_DAYS) return true
      if (sm2.ease > MAX_SANE_EASE) return true
      if (!DAY_KEY_RE.test(sm2.nextReview)) return true
    }
  }
  return false
}

// ============================================================
// 逐字核对与修复
// ============================================================

/** 逐字核对结果 */
export interface SnapshotVerification {
  /** 是否存在可验证且与日志重放不一致的字 */
  polluted: boolean
  /** 不一致的（孩子, 字）列表 */
  mismatches: Array<{ childId: string; character: string }>
}

/** 修复结果 */
export interface SnapshotRepairResult {
  /** 修复后的状态（未修复时等于输入） */
  state: AppState
  /** 被替换为日志重放值的字 */
  repaired: string[]
}

/** SM-2 状态六字段全等比较 */
function sm2StateEquals(a: SM2State, b: SM2State): boolean {
  return (
    a.ease === b.ease &&
    a.interval === b.interval &&
    a.repetitions === b.repetitions &&
    a.nextReview === b.nextReview &&
    a.lastGrade === b.lastGrade &&
    a.firstReviewDay === b.firstReviewDay
  )
}

/**
 * 用去重日志单次重放推导期望的 progress（保留快照结构，清空后重放）。
 * 复用 applyEntry——未到期防护与重放路径保持同一套语义。
 */
function computeExpectedProgress(state: AppState, entries: AnyLogEntry[]): AppState {
  const rebuilt = deepCloneState(state)
  for (const child of rebuilt.children) {
    child.progress = {}
    child.nextCharIndex = 0
  }
  const sorted = dedupeLogEntries(entries).sort((a, b) => a.timestamp - b.timestamp)
  for (const entry of sorted) {
    applyEntry(rebuilt, entry)
  }
  return rebuilt
}

/**
 * 快照与去重日志逐字核对。
 *
 * 只核对“日志覆盖完整”的字：快照 firstReviewDay 与重放结果一致，
 * 说明首次复习至今的所有日志都在——不一致才是污染。历史日志被
 * compaction/裁剪裁掉的字无法验证，一律跳过（不误报）。
 *
 * 历史教训：isSnapshotPolluted 的阈值（interval > 36500 / ease > 5 /
 * 非法日期）只抓极端爆炸；中度污染（同一复习被应用 3 次、interval
 * 恰好等于 36500 封顶、日期合法）全部漏检，污染快照得以持续流转。
 */
export function verifySnapshotAgainstLogs(
  state: AppState,
  entries: AnyLogEntry[],
): SnapshotVerification {
  const expected = computeExpectedProgress(state, entries)
  const mismatches: Array<{ childId: string; character: string }> = []

  for (const child of state.children) {
    const expChild = expected.children.find(c => c.id === child.id)
    if (!expChild) continue
    for (const [character, sm2] of Object.entries(child.progress)) {
      const exp = expChild.progress[character]
      if (!exp || exp.firstReviewDay !== sm2.firstReviewDay) continue // 历史不完整，不可验证
      if (sm2StateEquals(sm2, exp)) continue
      mismatches.push({ childId: child.id, character })
    }
  }

  return { polluted: mismatches.length > 0, mismatches }
}

/**
 * 逐字修复快照：完整历史且与日志重放不一致的字，用重放值替换。
 *
 * 与整库重建（rebuildStateFromLogs）的区别：只动可验证的字，
 * 历史日志缺失的字保持快照原值——避免丢失 compaction 裁掉的进度。
 * nextCharIndex 取 max（不完整历史会让重放低估指针）。
 */
export function repairSnapshotProgress(
  state: AppState,
  entries: AnyLogEntry[],
): SnapshotRepairResult {
  const repairedState = deepCloneState(state)
  const expected = computeExpectedProgress(state, entries)
  const repaired: string[] = []

  for (const child of repairedState.children) {
    const expChild = expected.children.find(c => c.id === child.id)
    if (!expChild) continue
    for (const [character, sm2] of Object.entries(child.progress)) {
      const exp = expChild.progress[character]
      if (!exp || exp.firstReviewDay !== sm2.firstReviewDay) continue
      if (sm2StateEquals(sm2, exp)) continue
      child.progress[character] = exp
      repaired.push(character)
    }
    child.nextCharIndex = Math.max(child.nextCharIndex, expChild.nextCharIndex)
  }

  return { state: repairedState, repaired }
}

/**
 * 从（去重后的）日志重建学习进度：保留快照结构（孩子、生字本、设置），
 * 清空 progress/nextCharIndex 后按时间戳顺序重放全部日志。
 *
 * progress 完全由复习日志推导，因此去重日志是进度的唯一可信来源；
 * 重建可修复重复应用造成的间隔爆炸。日志不完整时（如被裁剪）
 * 重建结果会缺失被裁剪的进度——仅在检测到污染时使用。
 */
export function rebuildStateFromLogs(state: AppState, entries: AnyLogEntry[]): AppState {
  const rebuilt = deepCloneState(state)
  for (const child of rebuilt.children) {
    child.progress = {}
    child.nextCharIndex = 0
  }
  const sorted = dedupeLogEntries(entries).sort((a, b) => a.timestamp - b.timestamp)
  for (const entry of sorted) {
    applyEntry(rebuilt, entry)
  }
  return rebuilt
}

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
    const modifiedAfter =
      lastKnownRemoteTime && lastKnownRemoteTime > 0
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
            delete parsed.id // Strip Dexie auto-increment id
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
    // 若远程快照被污染（历史同步 bug 的遗留），不采用——保留本地快照，
    // 由启动时的 repairPollutedData 用去重日志重建并推送修复。
    const localSnapshot = await getLatestSnapshot()
    const remotePolluted = remoteSnapshot ? isSnapshotPolluted(remoteSnapshot.state) : false
    const bestSnapshot =
      !remotePolluted &&
      (!localSnapshot || (remoteSnapshot && remoteSnapshot.timestamp > localSnapshot.timestamp))
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
    const candidateLowerBound =
      remoteTMin === Infinity ? 0 : Math.max(0, remoteTMin - CLOCK_SKEW_BUFFER)
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
      // 与导入同一规则：只重放快照时间戳之后的条目。
      // 快照（增量物化）已包含其 timestamp 之前所有日志的效果——全新浏览器
      // 全量拉取时远程 snapshot_current 是完整状态，重放已物化条目会把同一
      // 复习重复应用（reps 翻倍、interval 指数放大，如'途'字 3 次被算成 6 次、
      // interval 变成 595 天）。快照之后的条目不可能已被包含，必须重放补新。
      const sortedRemoteOnly = dedupedRemoteOnly
        .filter(e => e.timestamp > bestSnapshot!.timestamp)
        .sort((a, b) => a.timestamp - b.timestamp)
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
      didMerge: dedupedRemoteOnly.length > 0 || bestSnapshot !== localSnapshot,
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
export async function pushChanges(logEntries: AnyLogEntry[], snapshot: Snapshot): Promise<void> {
  const rootId = await findOrCreateRootFolder()

  // Push metadata
  const metaFile = await findFile(rootId, 'app_meta.json')
  await pushMeta(
    rootId,
    {
      lastKnownRemoteTime: Date.now(),
      version: '0.1.0',
    },
    metaFile?.id,
  )

  const snapshotData = JSON.stringify(snapshot)

  // 推送前去重：本地 DB 可能残留历史同步 bug 产生的重复条目，
  // 去重保证新创建的日志文件也是干净的（pushLogs 只对已有文件去重）
  const uniqueEntries = dedupeLogEntries(logEntries)

  // Group log entries by UTC interval key
  const logsByInterval = new Map<string, AnyLogEntry[]>()
  for (const entry of uniqueEntries) {
    const key = getIntervalKey(entry.timestamp)
    const group = logsByInterval.get(key)
    if (group) {
      group.push(entry)
    } else {
      logsByInterval.set(key, [entry])
    }
  }

  // Load historical snapshots for push
  const historical = uniqueEntries.length > 0 ? await getHistoricalSnapshots() : []

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
      const logLines = entries.map((l: AnyLogEntry & { id?: number }) => {
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
        await pushSnapshot(childFolderId, JSON.stringify(histSnap), null, histFileName)
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
      afterId = (lastEntry as AnyLogEntry & { id: number }).id
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
// 污染修复（启动时执行一次）
// ============================================================

export interface RepairResult {
  /** 快照是否被重建 */
  snapshotRepaired: boolean
  /** 被重写（去重）的 Drive 日志文件数 */
  filesRepaired: number
  /** 8a 兑底：被重置为 interval=1 的不可验证重污染字数 */
  salvaged: number
}

/** 8a 兑底阈值：10 年（正常复习链不可能达到，视为重复应用的确凿证据） */
export const SALVAGE_INTERVAL_DAYS = 3650

/**
 * 8a 兑底：历史日志不完整（无法逐字验证）且 interval 达到 10 年以上的字，
 * 是重复应用被封顶/放大的确凿证据——重置 interval=1、ease=2.5，
 * 让该字尽快重新进入复习队列，靠真实复习自然重建记忆状态。
 * 只动不可验证的字：可验证的字由逐字修复（repairSnapshotProgress）处理。
 */
export function salvageUnverifiableHeavy(state: AppState, entries: AnyLogEntry[]): string[] {
  const expected = computeExpectedProgress(state, entries)
  const salvaged: string[] = []

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowKey = toDateKey(tomorrow)

  for (const child of state.children) {
    const expChild = expected.children.find(c => c.id === child.id)
    if (!expChild) continue
    for (const [character, sm2] of Object.entries(child.progress)) {
      const exp = expChild.progress[character]
      const verifiable = exp !== undefined && exp.firstReviewDay === sm2.firstReviewDay
      if (verifiable) continue
      const heavy = sm2.interval >= SALVAGE_INTERVAL_DAYS || !DAY_KEY_RE.test(sm2.nextReview)
      if (!heavy) continue
      child.progress[character] = {
        ...sm2,
        ease: SM2_INITIAL_EASE,
        interval: SM2_INITIAL_INTERVAL,
        nextReview: tomorrowKey,
      }
      salvaged.push(character)
    }
  }
  return salvaged
}

/**
 * 修复历史同步 bug（重复追加日志条目）遗留的数据污染。
 *
 * 本地步骤（无需 token，离线也可自愈）：
 *   1. 清理本地日志表重复条目；
 *   2. 用本地日志对快照逐字核对，完整历史且不一致的字用重放值修复；
 *   3. 不可验证的重污染字（8a）重置 interval=1 尽快重新复习。
 * 云端步骤（需 token）：
 *   4. 重写 Drive 上含重复条目的日志文件（防止污染继续传播）；
 *   5. 本地快照被修复 / Drive 文件被重写 / 云端快照污染 → 推送本地
 *      干净快照覆盖云端污染版。
 *
 * 幂等：数据干净时不做任何写操作。启动时执行一次。
 */
export async function repairPollutedData(): Promise<RepairResult> {
  const result: RepairResult = { snapshotRepaired: false, filesRepaired: 0, salvaged: 0 }

  // ---- 本地步骤（离线自愈） ----
  try {
    await dedupeLocalLogs()

    const snapshot = await getLatestSnapshot()
    if (!snapshot) return result

    const localLogs = await getLogsAfter(0)
    if (localLogs.length > 0) {
      const { state: repaired, repaired: repairedChars } = repairSnapshotProgress(
        snapshot.state,
        localLogs,
      )
      const salvaged = salvageUnverifiableHeavy(repaired, localLogs)
      result.salvaged = salvaged.length
      if (repairedChars.length > 0 || salvaged.length > 0) {
        await saveCurrentSnapshot({ timestamp: Date.now(), state: repaired })
        result.snapshotRepaired = true
      }
    }
  } catch (err) {
    console.error('repairPollutedData local step failed:', err)
    return result
  }

  // ---- 云端步骤 ----
  if (!hasValidToken()) return result
  try {
    const rootId = await findOrCreateRootFolder()
    const snapshot = await getLatestSnapshot()
    if (!snapshot) return result

    // 1. 遍历日志文件：去重并重写污染文件
    for (const child of snapshot.state.children) {
      const childFolderId = await findOrCreateFolder(rootId, child.name)
      const files = await listFiles(childFolderId)
      for (const file of files) {
        if (!file.name.startsWith('log_')) continue
        const { repaired } = await repairLogFile(childFolderId, file.name, file.id)
        if (repaired) result.filesRepaired++
      }
    }

    // 2. 云端快照污染检测：用本地日志（并集）逐字核对每个孩子的
    //    snapshot_current.json——污染时用本地快照覆盖
    let remotePolluted = false
    const localLogs = await getLogsAfter(0)
    for (const child of snapshot.state.children) {
      const childFolderId = await findOrCreateFolder(rootId, child.name)
      const files = await listFiles(childFolderId)
      const snapFile = files.find(f => f.name === 'snapshot_current.json')
      if (!snapFile) continue
      try {
        const parsed = JSON.parse(await readFile(snapFile.id)) as Snapshot
        // 廉价阈值（interval 封顶/爆炸、非法日期）+ 逐字核对（中度污染）
        const pollutedByThreshold = parsed.state && isSnapshotPolluted(parsed.state)
        const pollutedByVerify =
          parsed.state && verifySnapshotAgainstLogs(parsed.state, localLogs).polluted
        if (pollutedByThreshold || pollutedByVerify) {
          remotePolluted = true
          break
        }
      } catch {
        // 无法解析的云端快照不阻塞本地修复
      }
    }

    // 3. 推送本地干净快照覆盖云端（本地已修复 / 文件已重写 / 云端快照污染）
    if (result.snapshotRepaired || result.filesRepaired > 0 || remotePolluted) {
      const snapshotData = JSON.stringify({ timestamp: Date.now(), state: snapshot.state })
      for (const child of snapshot.state.children) {
        const childFolderId = await findOrCreateFolder(rootId, child.name)
        const existing = await findFile(childFolderId, 'snapshot_current.json')
        await pushSnapshot(childFolderId, snapshotData, existing?.id)
      }
    }

    return result
  } catch (err) {
    console.error('repairPollutedData cloud step failed:', err)
    return result
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
  syncInterval = setInterval(
    async () => {
      if (navigator.onLine && hasValidToken()) {
        const didMerge = await syncOnce()
        if (didMerge) onMerged?.()
      }
    },
    5 * 60 * 1000,
  )
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
