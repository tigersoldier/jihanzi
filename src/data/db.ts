/**
 * IndexedDB Layer using Dexie.js
 *
 * Manages local persistence of:
 * - Log entries (append-only)
 * - Snapshot (latest compacted state)
 * - App metadata (for sync tracking)
 */

import Dexie, { type Table } from 'dexie'
import type { AnyLogEntry, ReviewEntry, Snapshot } from '../core/types'

/** Database schema version and definition */
class JihanziDB extends Dexie {
  logs!: Table<AnyLogEntry, number>     // Auto-incrementing primary key
  snapshot!: Table<Snapshot & { type: string; id?: number }, number>  // Snapshot table; type: 'current' | 'historical'
  meta!: Table<{ key: string; value: unknown }, string>  // Key-value metadata

  constructor() {
    super('jihanzi')

    this.version(1).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey',
      snapshot: '++id, timestamp',
      meta: 'key',
    })

    // v2: add compound index for efficient child+date range queries
    this.version(2).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey]',
      snapshot: '++id, timestamp',
      meta: 'key',
    })

    // v3: add [childId+character] index + snapshot type field for
    // incremental-materialization architecture
    this.version(3).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey], [childId+character]',
      snapshot: '++id, timestamp, type',
      meta: 'key',
    }).upgrade(async tx => {
      // Stamp the 'type' field on existing v2 snapshot rows so that
      // getLatestSnapshot() can find them via the new type index.
      const count = await tx.table('snapshot').count()
      if (count > 0) {
        await tx.table('snapshot').toCollection().modify(row => {
          row.type = 'current'
        })
      }
      // Repair any UTF-8 corrupted log entries from the historical
      // Drive encoding bug — iterate oldest-first, stop at first clean.
      await repairCorruptedLogs()
    })
  }
}

const db = new JihanziDB()

/** Type guard: filter AnyLogEntry[] down to ReviewEntry[] at runtime */
function filterReviews(entries: AnyLogEntry[]): ReviewEntry[] {
  return entries.filter((e): e is ReviewEntry => e.type === 'review')
}

// ============================================================
// UTF-8 Corruption Detection & Repair
// ============================================================

/**
 * Check whether a string contains UTF-8 corruption.
 *
 * Detects two classes of corruption:
 * 1. Lone surrogates (U+D800–U+DFFF) — invalid UTF-16 that cannot
 *    be encoded to valid UTF-8.
 * 2. C1 control characters (U+0080–U+009F) — these almost never appear
 *    in valid text and are a strong signal of UTF-8 bytes being
 *    misinterpreted as Latin-1 (mojibake).
 */
export function isUTF8Corrupted(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDFFF) {
      if (code >= 0xDC00) return true // Lone low surrogate
      if (i + 1 >= str.length || str.charCodeAt(i + 1) < 0xDC00 || str.charCodeAt(i + 1) > 0xDFFF) {
        return true // Lone high surrogate
      }
      i++
      continue
    }
    if (code >= 0x0080 && code <= 0x009F) return true
  }
  return false
}

/** Check if a log entry has a character field */
function hasCharacter(entry: AnyLogEntry): entry is AnyLogEntry & { character: string } {
  return 'character' in entry && typeof (entry as any).character === 'string'
}

/**
 * Repair UTF-8 corrupted log entries during v2→v3 migration.
 *
 * Iterates log entries one-by-one from the oldest. If an entry contains
 * corrupted character data it is collected for deletion. Once a clean
 * entry is found, iteration stops — all subsequent entries are assumed
 * clean because the encoding bug has been fixed in current code.
 *
 * Returns the count of deleted entries.
 */
export async function repairCorruptedLogs(): Promise<number> {
  const toDelete: number[] = []
  let foundClean = false

  await db.logs
    .orderBy('timestamp')
    .until(() => foundClean)
    .each(entry => {
      if (hasCharacter(entry) && isUTF8Corrupted(entry.character)) {
        const id = (entry as any).id
        if (typeof id === 'number') {
          toDelete.push(id)
        }
      } else if (hasCharacter(entry)) {
        // First clean entry with a character field — stop iterating
        foundClean = true
      }
    })

  if (toDelete.length > 0) {
    await db.logs.bulkDelete(toDelete)
  }
  return toDelete.length
}

// ============================================================
// Log Operations
// ============================================================

/** Append a single log entry to IndexedDB */
export async function appendLog(entry: AnyLogEntry): Promise<number> {
  return db.logs.add(entry)
}

/** Append multiple log entries (e.g., from sync) */
export async function appendLogs(entries: AnyLogEntry[]): Promise<number> {
  return db.logs.bulkAdd(entries)
}

/** Get log entries after a specific timestamp */
export async function getLogsAfter(timestamp: number): Promise<AnyLogEntry[]> {
  return db.logs.where('timestamp').above(timestamp).toArray()
}

/**
 * Get up to `limit` log entries at or after a timestamp, ordered by timestamp ascending.
 * Pass `afterId` (the last-seen entry's auto-increment id) to resume without
 * skipping entries that share the same timestamp as the batch boundary.
 */
export async function getLogsAfterPaginated(
  timestamp: number,
  limit: number,
  afterId?: number,
): Promise<AnyLogEntry[]> {
  const results = await db.logs
    .where('timestamp')
    .aboveOrEqual(timestamp)
    .limit(afterId !== undefined ? limit + 10 : limit)
    .toArray()

  if (afterId !== undefined) {
    return results.filter(e => (e as any).id > afterId).slice(0, limit)
  }
  return results.slice(0, limit)
}

/** Get the earliest and latest log timestamps in IndexedDB */
export async function getLogTimestampRange(): Promise<{ earliest: number | null; latest: number | null }> {
  const count = await db.logs.count()
  if (count === 0) return { earliest: null, latest: null }

  const first = await db.logs.orderBy('timestamp').first()
  const last = await db.logs.orderBy('timestamp').last()
  return {
    earliest: first?.timestamp ?? null,
    latest: last?.timestamp ?? null,
  }
}

/** Get log count */
export async function getLogCount(): Promise<number> {
  return db.logs.count()
}

/**
 * Prune the oldest N log entries.
 * Used when the total log count exceeds the threshold (500k).
 * Deletes entries ordered by timestamp ascending.
 */
export async function pruneOldestLogs(count: number): Promise<number> {
  return db.logs.orderBy('timestamp').limit(count).delete()
}

/** Get reviews for a specific child — uses childId index, filterReviews 处理 type */
export async function getReviewsForChild(childId: string): Promise<ReviewEntry[]> {
  return db.logs
    .where('childId')
    .equals(childId)
    .toArray()
    .then(filterReviews)
}

/** Get all reviews for a specific child and character — uses [childId+character] index, filterReviews 处理 type */
export async function getReviewsForChildChar(
  childId: string,
  character: string,
): Promise<ReviewEntry[]> {
  return db.logs
    .where({ childId, character })
    .toArray()
    .then(filterReviews)
}

/**
 * 分页获取指定孩子和字的复习记录 — cursor-based 分页。
 *
 * 利用 [childId+character] 复合索引中同键值记录按主键排序的特性：
 * reverse() 取最新（id 最大）在前，filter 限定 type==='review'，
 * limit(N) 限制每次最多读 N 条（不会物化全量记录）。
 *
 * 每次多取 1 条以判断 hasMore：load 51 条，返回最多 50 条 + cursor。
 * 多取的第 51 条在下一页作为第一条被重新读出，确保不丢数据。
 * 下一轮传入 cursor（上一页最后一条的 id）获取更早的条目。
 */
export async function getReviewsForChildCharPaginated(
  childId: string,
  character: string,
  limit: number = 51,
  afterId?: number,
): Promise<{ entries: ReviewEntry[]; hasMore: boolean; cursor: number | null }> {
  let collection = db.logs
    .where({ childId, character })
    .filter(e => e.type === 'review')

  // 游标分页：reverse 下 id 从大到小，只取 id < afterId 的更早记录
  if (afterId !== undefined) {
    collection = collection.filter(e => (e as any).id < afterId)
  }

  const entries = await collection
    .reverse()
    .limit(limit)
    .toArray() as (ReviewEntry & { id: number })[]


  const hasMore = entries.length === limit
  const result = entries.slice(0, limit - 1) as ReviewEntry[]

  return {
    entries: result,
    hasMore,
    cursor: result.length > 0 ? (result[result.length - 1] as any).id : null,
  }
}

/** Get reviews for a child within a dayKey range (inclusive) */
export async function getReviewsForChildInRange(
  childId: string,
  fromDay: string,
  toDay: string,
): Promise<ReviewEntry[]> {
  const result = await db.logs
    .where('[childId+dayKey]')
    .between([childId, fromDay], [childId, toDay], true, true)
    .filter(r => r.type === 'review')
    .sortBy('dayKey')
    .then(filterReviews)
  return result
}

// ============================================================
// Snapshot Operations
// ============================================================

const SNAPSHOT_TYPE_CURRENT = 'current'
const SNAPSHOT_TYPE_HISTORICAL = 'historical'

/** Get the current (latest) snapshot — the source of truth for app state */
export async function getLatestSnapshot(): Promise<Snapshot | null> {
  const result = await db.snapshot
    .where('type')
    .equals(SNAPSHOT_TYPE_CURRENT)
    .first()
  if (!result) return null
  // Strip the extra 'type' field before returning as Snapshot
  return { timestamp: result.timestamp, state: result.state }
}

/** Get all historical snapshots, newest first */
export async function getHistoricalSnapshots(): Promise<Snapshot[]> {
  const rows = await db.snapshot
    .where('type')
    .equals(SNAPSHOT_TYPE_HISTORICAL)
    .sortBy('timestamp')
  // Most recent first
  return rows.reverse().map(r => ({ timestamp: r.timestamp, state: r.state }))
}

/**
 * Find the nearest snapshot whose timestamp is ≤ beforeTimestamp.
 * Searches both current and historical snapshots.
 * Used for remote merge: find the base snapshot to replay from.
 */
/** Save/replace the current snapshot */
export async function saveCurrentSnapshot(snapshot: Snapshot): Promise<void> {
  const row = { ...snapshot, type: SNAPSHOT_TYPE_CURRENT }
  // Delete old current snapshot (there should be at most one)
  await db.snapshot.where('type').equals(SNAPSHOT_TYPE_CURRENT).delete()
  await db.snapshot.add(row)
}

/** Save a historical snapshot at an interval boundary */
export async function saveHistoricalSnapshot(snapshot: Snapshot): Promise<void> {
  const row = { ...snapshot, type: SNAPSHOT_TYPE_HISTORICAL }
  await db.snapshot.add(row)
}

/** Keep only the most recent `keepCount` historical snapshots, delete the rest */
export async function pruneOldSnapshots(keepCount: number): Promise<void> {
  const historical = await db.snapshot
    .where('type')
    .equals(SNAPSHOT_TYPE_HISTORICAL)
    .sortBy('timestamp')
  // Sort newest first, delete everything after keepCount
  historical.reverse()
  const toDelete = historical.slice(keepCount)
  const ids = toDelete.map(r => r.id).filter((id): id is number => id !== undefined)
  if (ids.length > 0) {
    await db.snapshot.bulkDelete(ids)
  }
}

// ============================================================
// Metadata Operations
// ============================================================

/** Get a metadata value */
export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key)
  return row?.value as T | undefined
}

/** Set a metadata value */
export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

/** Get the last known remote timestamp (Drive modifiedTime) */
export async function getLastKnownRemoteTime(): Promise<number> {
  return (await getMeta<number>('lastKnownRemoteTime')) || 0
}

/** Set the last known remote timestamp (Drive modifiedTime) */
export async function setLastKnownRemoteTime(timestamp: number): Promise<void> {
  await setMeta('lastKnownRemoteTime', timestamp)
}

export default db
