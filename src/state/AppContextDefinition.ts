import { createContext, useContext } from 'react'
import type { AppState, AnyLogEntry, Settings } from '../core/types'

export interface AppContextState {
  state: AppState
  loading: boolean
  /** Incremented after sync reloads and review writes so log-derived hooks can re-query IndexedDB */
  dataVersion: number
  /** Currently selected child — shared across tabs */
  selectedChildId: string
  setSelectedChildId: (id: string) => void
  // Child operations
  createChild: (name: string, wordBookId: string) => Promise<string>
  updateChild: (childId: string, updates: { name?: string; wordBookId?: string }) => Promise<void>
  deleteChild: (childId: string) => Promise<void>
  // Word book operations
  createWordBook: (name: string, characters?: string[]) => Promise<string>
  updateWordBook: (wordBookId: string, name: string) => Promise<void>
  deleteWordBook: (wordBookId: string) => Promise<void>
  addCharacter: (wordBookId: string, character: string) => Promise<void>
  removeCharacter: (wordBookId: string, character: string, index: number) => Promise<void>
  reorderCharacters: (wordBookId: string, characters: string[]) => Promise<void>
  // Review operations
  submitReview: (
    childId: string,
    character: string,
    grade: 'a' | 'b' | 'c' | 'd',
    round: number,
    dayKey: string,
  ) => Promise<void>
  /** Record a presenting-phase completion (audit log, no state change) */
  submitPresentChars: (childId: string, characters: string[], dayKey: string) => Promise<void>
  // Settings operations
  updateSettings: (settings: Partial<Settings>) => Promise<void>
  // Data management
  getLogEntries: () => Promise<AnyLogEntry[]>
  /** Import a snapshot + log entries — writes to IndexedDB and reloads state */
  bulkImport: (
    snapshot: { timestamp: number; appliedThrough?: number; state: AppState },
    logs: AnyLogEntry[],
  ) => Promise<void>
  /** Reload state from IndexedDB — called after Drive pull merges new data */
  reloadState: () => void
}

export const AppContext = createContext<AppContextState | null>(null)

export function useApp(): AppContextState {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return context
}
