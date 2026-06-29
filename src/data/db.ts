/**
 * IndexedDB Layer using Dexie.js
 *
 * Manages local persistence of:
 * - Log entries (append-only)
 * - Snapshot (latest compacted state)
 * - App metadata (for sync tracking)
 */

import Dexie, { type Table } from 'dexie'
import type { AnyLogEntry, Snapshot } from '../core/types'

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
  }
}

const db = new JihanziDB()

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
  return db.logs.orderBy('timestamp').toArray()
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
export async function getReviewsForChild(childId: string): Promise<AnyLogEntry[]> {
  return db.logs
    .where({ type: 'review', childId })
    .toArray()
}

/** Get reviews for a specific day */
export async function getReviewsForDay(dayKey: string): Promise<AnyLogEntry[]> {
  return db.logs
    .where({ type: 'review', dayKey })
    .toArray()
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
