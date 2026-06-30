import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import type {
  AppState,
  AnyLogEntry,
  Child,
  WordBook,
  Settings,
  ReviewEntry,
  CreateChildEntry,
  CreateWordBookEntry,
  AddCharEntry,
  RemoveCharEntry,
  ReorderCharsEntry,
  UpdateSettingsEntry,
  DeleteChildEntry,
  DeleteWordBookEntry,
  UpdateChildEntry,
  UpdateWordBookEntry,
} from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'
import { replayLog } from '../core/log'
import { generateTimestamp } from '../core/log'
import {
  appendLog,
  getAllLogs,
  getLatestSnapshot,
  saveSnapshot,
  deleteLogsBefore,
} from '../data/db'
import { compactLogs } from '../core/snapshot'
import { LOG_SNAPSHOT_THRESHOLD } from '../core/log'
import { validateAddChar } from '../utils/chars'
import { useAuth } from './AuthContext'

export interface AppContextState {
  state: AppState
  loading: boolean
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
  submitReview: (childId: string, character: string, grade: 'a' | 'b' | 'c' | 'd', round: number, dayKey: string) => Promise<void>
  // Settings operations
  updateSettings: (settings: Partial<Settings>) => Promise<void>
  // Data management
  getLogEntries: () => Promise<AnyLogEntry[]>
}

export const AppContext = createContext<AppContextState | null>(null)

const EMPTY_STATE: AppState = {
  children: [],
  wordBooks: [],
  settings: { ...DEFAULT_SETTINGS },
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { isLoggedIn } = useAuth()
  const [state, setState] = useState<AppState>(EMPTY_STATE)
  const [loading, setLoading] = useState(true)
  const [logCount, setLogCount] = useState(0)
  // Ref mirror of state.wordBooks so addCharacter can validate without
  // adding state as a useCallback dependency.
  const wordBooksRef = useRef(state.wordBooks)
  wordBooksRef.current = state.wordBooks

  // Load state from IndexedDB on mount (after login)
  useEffect(() => {
    if (!isLoggedIn) return

    async function loadState() {
      setLoading(true)
      try {
        const snapshot = await getLatestSnapshot()
        const logs = await getAllLogs()
        const reconstructed = replayLog(snapshot, logs)
        setState(reconstructed)
        setLogCount(logs.length)
      } catch (err) {
        console.error('Failed to load state:', err)
      } finally {
        setLoading(false)
      }
    }

    loadState()
  }, [isLoggedIn])

  // Helper: append a log entry.
  // Uses functional setState so the callback never goes stale — even callbacks
  // that captured this on the first render correctly increment the latest count.
  const appendEntry = useCallback(async (entry: AnyLogEntry): Promise<void> => {
    await appendLog(entry)
    setLogCount(prev => prev + 1)
  }, [])

  // Compaction: when the log grows past the threshold, generate a fresh
  // snapshot and prune old log entries. Separated from appendEntry so that
  // appendEntry stays stable (no stale logCount dependency).
  //
  // Uses a debounce timer so rapid bursts of appends don't repeatedly
  // cancel and restart the expensive getAllLogs + compactLogs work.
  const compacting = useRef(false)
  const compactTimer = useRef<ReturnType<typeof setTimeout>>()
  useEffect(() => {
    if (logCount < LOG_SNAPSHOT_THRESHOLD) return
    if (compacting.current) return

    // Debounce: wait for a quiet period before starting compaction
    clearTimeout(compactTimer.current)
    compactTimer.current = setTimeout(() => {
      compacting.current = true
      let cancelled = false

      async function compact() {
        try {
          const oldSnapshot = await getLatestSnapshot()
          if (cancelled) return
          const logs = await getAllLogs()
          if (cancelled) return
          const { snapshot: newSnapshot, logs: remaining } = compactLogs(oldSnapshot, logs)
          await saveSnapshot(newSnapshot)
          if (!cancelled) {
            // Delete logs covered by the new snapshot.  Use
            // newSnapshot.timestamp so that only logs already
            // incorporated into the snapshot are pruned.
            await deleteLogsBefore(newSnapshot.timestamp)
          }
          if (!cancelled) {
            // Count surviving logs (those appended after the snapshot)
            setLogCount(remaining.length)
          }
        } catch (err) {
          console.error('Compaction failed:', err)
        } finally {
          compacting.current = false
        }
      }
      compact()

      // Return a no-op cleanup — the cancellation flag is scoped inside
      // the setTimeout so it only applies to this compaction attempt.
      return () => { cancelled = true }
    }, 1000) // 1s quiet period before compacting

    return () => { clearTimeout(compactTimer.current) }
  }, [logCount])

  // ---- Child Operations ----

  const createChild = useCallback(async (name: string, wordBookId: string): Promise<string> => {
    const childId = `child_${generateTimestamp()}`
    const entry: CreateChildEntry = {
      timestamp: generateTimestamp(),
      type: 'create_child',
      childId,
      name,
      wordBookId,
    }
    await appendEntry(entry)
    // Optimistic update
    setState(prev => ({
      ...prev,
      children: [...prev.children, { id: childId, name, wordBookId, nextCharIndex: 0, progress: {} }],
    }))
    return childId
  }, [])

  const updateChild = useCallback(async (childId: string, updates: { name?: string; wordBookId?: string }) => {
    const entry: UpdateChildEntry = {
      timestamp: generateTimestamp(),
      type: 'update_child',
      childId,
      ...updates,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      children: prev.children.map(c =>
        c.id === childId ? { ...c, ...updates } : c
      ),
    }))
  }, [])

  const deleteChild = useCallback(async (childId: string) => {
    const entry: DeleteChildEntry = {
      timestamp: generateTimestamp(),
      type: 'delete_child',
      childId,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      children: prev.children.filter(c => c.id !== childId),
    }))
  }, [])

  // ---- Word Book Operations ----

  const createWordBook = useCallback(async (name: string, characters: string[] = []): Promise<string> => {
    const wordBookId = `wb_${generateTimestamp()}`
    const entry: CreateWordBookEntry = {
      timestamp: generateTimestamp(),
      type: 'create_wordbook',
      wordBookId,
      name,
      characters,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      wordBooks: [...prev.wordBooks, { id: wordBookId, name, characters }],
    }))
    return wordBookId
  }, [])

  const updateWordBook = useCallback(async (wordBookId: string, name: string) => {
    const entry: UpdateWordBookEntry = {
      timestamp: generateTimestamp(),
      type: 'update_wordbook',
      wordBookId,
      name,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      wordBooks: prev.wordBooks.map(w =>
        w.id === wordBookId ? { ...w, name } : w
      ),
    }))
  }, [])

  const deleteWordBook = useCallback(async (wordBookId: string) => {
    const entry: DeleteWordBookEntry = {
      timestamp: generateTimestamp(),
      type: 'delete_wordbook',
      wordBookId,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      wordBooks: prev.wordBooks.filter(w => w.id !== wordBookId),
    }))
  }, [])

  const addCharacter = useCallback(async (wordBookId: string, character: string) => {
    // Validate BEFORE setState so errors propagate to the caller.
    // Reading from a ref avoids adding state.wordBooks as a dependency,
    // keeping the callback stable across renders.
    const wb = wordBooksRef.current.find(w => w.id === wordBookId)
    if (!wb) return
    validateAddChar(character, wb)

    const entry: AddCharEntry = {
      timestamp: generateTimestamp(),
      type: 'add_char',
      wordBookId,
      character,
      index: wb.characters.length,
    }

    // Persist first, then optimistic update — consistent with all
    // other mutation operations.
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      wordBooks: prev.wordBooks.map(w =>
        w.id === wordBookId
          ? { ...w, characters: [...w.characters, character] }
          : w
      ),
    }))
  }, [])

  const removeCharacter = useCallback(async (wordBookId: string, character: string, index: number) => {
    const entry: RemoveCharEntry = {
      timestamp: generateTimestamp(),
      type: 'remove_char',
      wordBookId,
      character,
      index,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      wordBooks: prev.wordBooks.map(w =>
        w.id === wordBookId
          ? { ...w, characters: w.characters.filter((_, i) => i !== index) }
          : w
      ),
    }))
  }, [])

  const reorderCharacters = useCallback(async (wordBookId: string, characters: string[]) => {
    const entry: ReorderCharsEntry = {
      timestamp: generateTimestamp(),
      type: 'reorder_chars',
      wordBookId,
      characters,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      wordBooks: prev.wordBooks.map(w =>
        w.id === wordBookId ? { ...w, characters } : w
      ),
    }))
  }, [])

  // ---- Review Operations ----

  const submitReview = useCallback(async (
    childId: string,
    character: string,
    grade: 'a' | 'b' | 'c' | 'd',
    round: number,
    dayKey: string,
  ) => {
    const entry: ReviewEntry = {
      timestamp: generateTimestamp(),
      type: 'review',
      childId,
      character,
      grade,
      round,
      dayKey,
    }
    await appendEntry(entry)

    // Only round 1 affects SM-2 state
    if (round === 1) {
      setState(prev => {
        // Replay the review entry against the current state so existing
        // children, wordBooks, and settings are preserved.
        const newState = replayLog({ timestamp: 0, state: prev }, [entry])
        return newState
      })
    }
  }, [])

  // ---- Settings Operations ----

  const updateSettings = useCallback(async (settings: Partial<Settings>) => {
    const entry: UpdateSettingsEntry = {
      timestamp: generateTimestamp(),
      type: 'update_settings',
      settings,
    }
    await appendEntry(entry)
    setState(prev => ({
      ...prev,
      settings: { ...prev.settings, ...settings },
    }))
  }, [])

  // ---- Data Management ----

  const getLogEntries = useCallback(async (): Promise<AnyLogEntry[]> => {
    return getAllLogs()
  }, [])

  return (
    <AppContext.Provider
      value={{
        state,
        loading,
        createChild,
        updateChild,
        deleteChild,
        createWordBook,
        updateWordBook,
        deleteWordBook,
        addCharacter,
        removeCharacter,
        reorderCharacters,
        submitReview,
        updateSettings,
        getLogEntries,
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useApp(): AppContextState {
  const context = useContext(AppContext)
  if (!context) {
    throw new Error('useApp must be used within an AppProvider')
  }
  return context
}
