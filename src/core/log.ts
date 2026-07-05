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
  Snapshot,
} from './types'
import { DEFAULT_SETTINGS } from './types'
import { updateSM2 } from './sm2'

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
 * Returns true if the state was actually changed, false if the entry was a no-op
 * (e.g. consolidation rounds, idempotent updates).
 */
export function applyEntry(state: AppState, entry: AnyLogEntry): boolean {
  switch (entry.type) {
    case 'create_child':
      applyCreateChild(state, entry)
      return true
    case 'update_child':
      return applyUpdateChild(state, entry)
    case 'delete_child':
      return applyDeleteChild(state, entry)
    case 'create_wordbook':
      applyCreateWordBook(state, entry)
      return true
    case 'update_wordbook':
      return applyUpdateWordBook(state, entry)
    case 'delete_wordbook':
      return applyDeleteWordBook(state, entry)
    case 'add_char':
      applyAddChar(state, entry)
      return true
    case 'remove_char':
      return applyRemoveChar(state, entry)
    case 'reorder_chars':
      return applyReorderChars(state, entry)
    case 'review':
      return applyReview(state, entry)
    case 'update_settings':
      return applyUpdateSettings(state, entry)
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
}): boolean {
  const child = state.children.find(c => c.id === entry.childId)
  if (!child) return false
  if (entry.name === undefined && entry.wordBookId === undefined) return false
  let changed = false
  if (entry.name !== undefined && child.name !== entry.name) {
    child.name = entry.name
    changed = true
  }
  if (entry.wordBookId !== undefined && child.wordBookId !== entry.wordBookId) {
    child.wordBookId = entry.wordBookId
    changed = true
  }
  return changed
}

function applyDeleteChild(state: AppState, entry: { type: 'delete_child'; childId: string }): boolean {
  const before = state.children.length
  state.children = state.children.filter(c => c.id !== entry.childId)
  return state.children.length !== before
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
}): boolean {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return false
  if (entry.name === undefined) return false
  if (wb.name === entry.name) return false
  wb.name = entry.name
  return true
}

function applyDeleteWordBook(state: AppState, entry: {
  type: 'delete_wordbook'
  wordBookId: string
}): boolean {
  const before = state.wordBooks.length
  state.wordBooks = state.wordBooks.filter(w => w.id !== entry.wordBookId)
  return state.wordBooks.length !== before
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
}): boolean {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return false
  if (wb.characters[entry.index] !== entry.character) return false
  wb.characters.splice(entry.index, 1)
  return true
}

function applyReorderChars(state: AppState, entry: {
  type: 'reorder_chars'
  wordBookId: string
  characters: string[]
}): boolean {
  const wb = state.wordBooks.find(w => w.id === entry.wordBookId)
  if (!wb) return false
  // Check if the order actually changed
  if (arraysEqual(wb.characters, entry.characters)) return false
  wb.characters = entry.characters
  return true
}

function applyReview(state: AppState, entry: ReviewEntry): boolean {
  // Only round 1 reviews feed into SM-2; consolidation rounds are log-only
  if (entry.round !== 1) return false

  const child = state.children.find(c => c.id === entry.childId)
  if (!child) return false

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

  return true
}

function applyUpdateSettings(state: AppState, entry: {
  type: 'update_settings'
  settings: Partial<Settings>
}): boolean {
  let changed = false
  for (const [key, value] of Object.entries(entry.settings)) {
    if (value !== undefined && (state.settings as any)[key] !== value) {
      (state.settings as any)[key] = value
      changed = true
    }
  }
  return changed
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
export function deepCloneState(state: AppState): AppState {
  return JSON.parse(JSON.stringify(state))
}

/** Shallow array equality check for reorder detection */
function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
