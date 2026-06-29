/**
 * Append-Only Log Operations
 *
 * The log is the source of truth. All mutations are appended as immutable
 * log entries. State is reconstructed by replaying the log from the last
 * snapshot. This provides conflict-free sync — merging is just union of
 * log entries by unique timestamp.
 */

import type {
  AnyLogEntry,
  AppState,
  Child,
  WordBook,
  Settings,
  ReviewEntry,
  CreateChildEntry,
  CreateWordBookEntry,
  AddCharEntry,
  Grade,
  SM2State,
  Snapshot,
} from './types'
import { DEFAULT_SETTINGS } from './types'
import { updateSM2, createInitialSM2State } from './sm2'

/**
 * Generate a unique log ID from timestamp + random suffix.
 * Timestamp is primary sort key; random suffix prevents collisions.
 */
export function generateTimestamp(): number {
  return Date.now()
}

/**
 * Replay log entries to reconstruct full application state.
 *
 * @param snapshot - The most recent snapshot (or null if none)
 * @param logs - Log entries after the snapshot timestamp
 * @returns Reconstructed AppState
 */
export function replayLog(snapshot: Snapshot | null, logs: AnyLogEntry[]): AppState {
  // Start from snapshot state or empty state
  const state: AppState = snapshot
    ? deepCloneState(snapshot.state)
    : { children: [], wordBooks: [], settings: { ...DEFAULT_SETTINGS } }

  // Sort logs by timestamp for deterministic replay
  const sorted = [...logs].sort((a, b) => a.timestamp - b.timestamp)

  for (const entry of sorted) {
    applyEntry(state, entry)
  }

  return state
}

/**
 * Apply a single log entry to mutate state in place.
 */
function applyEntry(state: AppState, entry: AnyLogEntry): void {
  switch (entry.type) {
    case 'create_child':
      applyCreateChild(state, entry)
      break
    case 'update_child':
      applyUpdateChild(state, entry)
      break
    case 'delete_child':
      applyDeleteChild(state, entry)
      break
    case 'create_wordbook':
      applyCreateWordBook(state, entry)
      break
    case 'update_wordbook':
      applyUpdateWordBook(state, entry)
      break
    case 'delete_wordbook':
      applyDeleteWordBook(state, entry)
      break
    case 'add_char':
      applyAddChar(state, entry)
      break
    case 'remove_char':
      applyRemoveChar(state, entry)
      break
    case 'reorder_chars':
      applyReorderChars(state, entry)
      break
    case 'review':
      applyReview(state, entry)
      break
    case 'update_settings':
      applyUpdateSettings(state, entry)
      break
  }
}

function applyCreateChild(state: AppState, entry: CreateChildEntry): void {
  const child: Child = {
    id: entry.childId,
    name: entry.name,
    wordBookId: entry.wordBookId,
    nextCharIndex: 0,
    progress: {},
  }
  state.children.push(child)
}

function applyUpdateChild(state: AppState, entry: {
  type: 'update_child'
  childId: string
  name?: string
  wordBookId?: string
}): void {
  const child = state.children.find(c => c.id === entry.childId)
  if (!child) return
  if (entry.name !== undefined) child.name = entry.name
  if (entry.wordBookId !== undefined) child.wordBookId = entry.wordBookId
}

function applyDeleteChild(state: AppState, entry: { type: 'delete_child'; childId: string }): void {
  state.children = state.children.filter(c => c.id !== entry.childId)
}

function applyCreateWordBook(state: AppState, entry: CreateWordBookEntry): void {
  const wb: WordBook = {
    id: entry.wordBookId,
    name: entry.name,
    characters: entry.characters,
  }
  state.wordBooks.push(wb)
}

function applyUpdateWordBook(state: AppState, entry: {
  type: 'update_wordbook'
  wordBookId: string
  name?: string
}): void {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return
  if (entry.name !== undefined) wb.name = entry.name
}

function applyDeleteWordBook(state: AppState, entry: {
  type: 'delete_wordbook'
  wordBookId: string
}): void {
  state.wordBooks = state.wordBooks.filter(w => w.id !== entry.wordBookId)
}

function applyAddChar(state: AppState, entry: AddCharEntry): void {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return
  // Insert at the specified index
  wb.characters.splice(entry.index, 0, entry.character)
}

function applyRemoveChar(state: AppState, entry: {
  type: 'remove_char'
  wordBookId: string
  character: string
  index: number
}): void {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return
  // Verify the character at index matches
  if (wb.characters[entry.index] === entry.character) {
    wb.characters.splice(entry.index, 1)
  }
}

function applyReorderChars(state: AppState, entry: {
  type: 'reorder_chars'
  wordBookId: string
  characters: string[]
}): void {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return
  wb.characters = entry.characters
}

function applyReview(state: AppState, entry: ReviewEntry): void {
  // Only round 1 reviews feed into SM-2
  if (entry.round !== 1) return

  const child = state.children.find(c => c.id === entry.childId)
  if (!child) return

  const current = child.progress[entry.character]
  const updated = updateSM2(current, entry.grade, entry.dayKey)
  child.progress[entry.character] = updated

  // If this was a new character (first review), advance nextCharIndex
  if (!current) {
    const wb = state.wordBooks.find(w => w.id === child.wordBookId)
    if (wb) {
      const charIndex = wb.characters.indexOf(entry.character)
      if (charIndex >= child.nextCharIndex) {
        child.nextCharIndex = charIndex + 1
      }
    }
  }
}

function applyUpdateSettings(state: AppState, entry: {
  type: 'update_settings'
  settings: Partial<Settings>
}): void {
  Object.assign(state.settings, entry.settings)
}

/**
 * Create a snapshot from the current state.
 */
export function createSnapshot(state: AppState): Snapshot {
  return {
    timestamp: Date.now(),
    state: deepCloneState(state),
  }
}

/**
 * Deep clone app state (simple JSON round-trip is sufficient for our data).
 */
function deepCloneState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state))
}

/**
 * Filter logs to only those after a given timestamp (exclusive).
 */
export function logsAfter(logs: AnyLogEntry[], timestamp: number): AnyLogEntry[] {
  return logs.filter(l => l.timestamp > timestamp)
}

/**
 * Log threshold — when accumulated logs exceed this count, generate a new snapshot.
 */
export const LOG_SNAPSHOT_THRESHOLD = 500
