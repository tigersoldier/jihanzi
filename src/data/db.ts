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
  snapshot!: Table<Snapshot, number>     // Single-row snapshot table
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
  }
}

const db = new JihanziDB()

/** Type guard: filter AnyLogEntry[] down to ReviewEntry[] at runtime */
function filterReviews(entries: AnyLogEntry[]): ReviewEntry[] {
  return entries.filter((e): e is ReviewEntry => e.type === 'review')
}

// ============================================================
// UTF-8 Corruption Detection
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
 *
 * This function is used by getAllLogs to auto-repair corrupted data
 * caused by the historical Drive sync encoding bug where UTF-8 bytes
 * were decoded as Latin-1.
 */
export function isUTF8Corrupted(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xD800 && code <= 0xDFFF) {
      // High surrogate must be followed by a low surrogate
      if (code >= 0xDC00) return true // Lone low surrogate
      if (i + 1 >= str.length || str.charCodeAt(i + 1) < 0xDC00 || str.charCodeAt(i + 1) > 0xDFFF) {
        return true // Lone high surrogate
      }
      i++ // Skip the paired low surrogate
      continue
    }
    // C1 control characters (U+0080–U+009F): almost certainly mojibake
    // from UTF-8 bytes misinterpreted as Latin-1
    if (code >= 0x0080 && code <= 0x009F) return true
  }
  return false
}

/** Check if a log entry has a character field */
function hasCharacter(entry: AnyLogEntry): entry is AnyLogEntry & { character: string } {
  return 'character' in entry && typeof (entry as any).character === 'string'
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

/** Get all log entries, sorted by timestamp */
export async function getAllLogs(): Promise<AnyLogEntry[]> {
  const result = await db.logs.orderBy('timestamp').toArray()

  // ---- UTF-8 corruption auto-repair ----
  // If entries were synced from Drive during the encoding-bug period,
  // Chinese characters may have been corrupted (UTF-8 bytes → Latin-1).
  // Detect by checking the first entry with a character field.
  const firstWithChar = result.find(hasCharacter)
  if (firstWithChar && isUTF8Corrupted(firstWithChar.character)) {
    const corrupted = result.filter(e => hasCharacter(e) && isUTF8Corrupted(e.character))
    const corruptedIds = corrupted.map(e => (e as any).id).filter((id): id is number => typeof id === 'number')
    if (corruptedIds.length > 0) {
      await db.logs.bulkDelete(corruptedIds)
    }
    return result.filter(e => !hasCharacter(e) || !isUTF8Corrupted(e.character))
  }

  return result
}

/** Get log entries after a specific timestamp */
export async function getLogsAfter(timestamp: number): Promise<AnyLogEntry[]> {
  return db.logs.where('timestamp').above(timestamp).toArray()
}

/** Get log count */
export async function getLogCount(): Promise<number> {
  return db.logs.count()
}

/** Delete logs older than a timestamp (after snapshot compaction) */
export async function deleteLogsBefore(timestamp: number): Promise<number> {
  return db.logs.where('timestamp').belowOrEqual(timestamp).delete()
}

/** Get reviews for a specific child */
export async function getReviewsForChild(childId: string): Promise<ReviewEntry[]> {
  return db.logs
    .where({ type: 'review', childId })
    .toArray()
    .then(filterReviews)
}

/** Get reviews for a specific day */
export async function getReviewsForDay(dayKey: string): Promise<ReviewEntry[]> {
  return db.logs
    .where({ type: 'review', dayKey })
    .toArray()
    .then(filterReviews)
}

/** Get all reviews for a specific child and character */
export async function getReviewsForChildChar(
  childId: string,
  character: string,
): Promise<ReviewEntry[]> {
  return db.logs
    .where({ type: 'review', childId })
    .toArray()
    .then(filterReviews)
    .then(entries => entries.filter(r => r.character === character))
}

/**
 * Get the first review dayKey for each character for a child.
 * Used to classify characters as "new" vs "review" on a given day.
 */
export async function getFirstReviewDays(
  childId: string,
): Promise<Map<string, string>> {
  const firstDays = new Map<string, string>()
  await db.logs
    .where({ type: 'review', childId })
    .each(r => {
      if (r.type !== 'review') return
      const current = firstDays.get(r.character)
      if (!current || r.dayKey < current) {
        firstDays.set(r.character, r.dayKey)
      }
    })
  return firstDays
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

/** Get the latest snapshot */
export async function getLatestSnapshot(): Promise<Snapshot | null> {
  const snapshots = await db.snapshot.orderBy('timestamp').reverse().limit(1).toArray()
  return snapshots[0] || null
}

/** Save a new snapshot (replaces old ones) */
export async function saveSnapshot(snapshot: Snapshot): Promise<void> {
  // Clear old snapshots and save new one
  await db.snapshot.clear()
  await db.snapshot.add(snapshot)
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

/** Get the last sync timestamp */
export async function getLastSyncTime(): Promise<number> {
  return (await getMeta<number>('lastSyncTime')) || 0
}

/** Set the last sync timestamp */
export async function setLastSyncTime(timestamp: number): Promise<void> {
  await setMeta('lastSyncTime', timestamp)
}

export default db
