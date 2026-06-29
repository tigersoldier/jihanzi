/**
 * Snapshot management for append-only log compaction.
 *
 * When the log grows beyond LOG_SNAPSHOT_THRESHOLD, we generate a new snapshot
 * and prune old log entries that are covered by it. The snapshot captures the
 * full state at a point in time, and only logs after that timestamp need to be
 * replayed to get current state.
 */

import type { AnyLogEntry, AppState, Snapshot } from './types'
import { replayLog, createSnapshot, LOG_SNAPSHOT_THRESHOLD } from './log'

/**
 * Determine if a new snapshot should be generated based on log count.
 */
export function shouldGenerateSnapshot(
  logCount: number,
  lastSnapshot: Snapshot | null,
): boolean {
  if (logCount >= LOG_SNAPSHOT_THRESHOLD) return true
  return false
}

/**
 * Compact logs by generating a new snapshot and returning only
 * the logs that are after the new snapshot.
 *
 * @param snapshot - Current latest snapshot (or null)
 * @param logs - All log entries
 * @returns { snapshot: new Snapshot, logs: remaining logs after snapshot }
 */
export function compactLogs(
  snapshot: Snapshot | null,
  logs: AnyLogEntry[],
): { snapshot: Snapshot; logs: AnyLogEntry[] } {
  // Replay all logs to get current state
  const state = replayLog(snapshot, logs)
  const newSnapshot = createSnapshot(state)

  // After compaction, all logs are covered by the snapshot
  return { snapshot: newSnapshot, logs: [] }
}

/**
 * Rebuild state from a snapshot and logs.
 * This is the main entry point for state reconstruction.
 */
export function rebuildState(
  snapshot: Snapshot | null,
  logs: AnyLogEntry[],
): AppState {
  return replayLog(snapshot, logs)
}
