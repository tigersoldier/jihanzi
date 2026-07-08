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
  ReviewEntry,
  PresentCharsEntry,
} from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'
import { applyEntry, deepCloneState } from '../core/log'
import { generateTimestamp } from '../core/log'
import db, {
  appendLog,
  appendLogs,
  getLatestSnapshot,
  saveCurrentSnapshot,
  saveHistoricalSnapshot,
  pruneOldSnapshots,
  getLogCount,
  pruneOldestLogs,
} from '../data/db'
import { getIntervalKey } from '../utils/date'
import { validateAddChar } from '../utils/chars'
import { useAuth } from './AuthContext'
import { notifyDataChanged } from '../data/sync'

export interface AppContextState {
  state: AppState
  loading: boolean
  /** Incremented after each sync-driven reload — hooks can watch this to re-query IndexedDB */
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
  submitReview: (childId: string, character: string, grade: 'a' | 'b' | 'c' | 'd', round: number, dayKey: string) => Promise<void>
  /** Record a presenting-phase completion (audit log, no state change) */
  submitPresentChars: (childId: string, characters: string[], dayKey: string) => Promise<void>
  // Settings operations
  updateSettings: (settings: Partial<Settings>) => Promise<void>
  // Data management
  getLogEntries: () => Promise<AnyLogEntry[]>
  /** Import a snapshot + log entries — writes to IndexedDB and reloads state */
  bulkImport: (snapshot: { timestamp: number; state: AppState }, logs: AnyLogEntry[]) => Promise<void>
  /** Reload state from IndexedDB — called after Drive pull merges new data */
  reloadState: () => void
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
  const [dataVersion, setDataVersion] = useState(0)
  const [selectedChildId, setSelectedChildId] = useState<string>('')

  // Auto-select the first child when children become available
  useEffect(() => {
    if (state.children.length > 0 && !selectedChildId) {
      setSelectedChildId(state.children[0].id)
    }
  }, [state.children, selectedChildId])

  // Ref mirror of state.wordBooks so addCharacter can validate without
  // adding state as a useCallback dependency.
  const wordBooksRef = useRef(state.wordBooks)
  wordBooksRef.current = state.wordBooks

  // Load state from IndexedDB on mount (after login) or when
  // reloadKey is incremented by SyncContext after a Drive pull.
  const [reloadKey, setReloadKey] = useState(0)

  const reloadState = useCallback(() => {
    setReloadKey(k => k + 1)
  }, [])

  useEffect(() => {
    if (!isLoggedIn) return

    async function loadState() {
      setLoading(true)
      try {
        const snapshot = await getLatestSnapshot()
        if (snapshot) {
          setState(snapshot.state)
        } else {
          setState(EMPTY_STATE)
        }
        setDataVersion(v => v + 1)
      } catch (err) {
        console.error('Failed to load state:', err)
      } finally {
        setLoading(false)
      }
    }

    loadState()
  }, [isLoggedIn, reloadKey])

  // Helper: persist a mutation atomically.
  //
  // 1. Clones the current snapshot state
  // 2. Applies the entry via applyEntry (canonical mutation path)
  // 3. In a Dexie transaction: writes log + optionally updates snapshot
  // 4. Updates React state if applyEntry returned true
  // 5. Checks log pruning threshold
  //
  // Consolidation rounds (round != 1) write the log entry for sync but
  // don't update the snapshot.
  const applyAndPersist = useCallback(async (
    entry: AnyLogEntry,
  ): Promise<boolean> => {
    const now = Date.now()
    let changed = false
    let newState: AppState = EMPTY_STATE

    await db.transaction('rw', db.logs, db.snapshot, async () => {
      // Read snapshot INSIDE the transaction to avoid TOCTOU races
      // with other tabs or sync-driven snapshot writes.
      const currentSnapshot = await getLatestSnapshot()
      const prevState = currentSnapshot?.state || EMPTY_STATE
      const cloned = deepCloneState(prevState)
      changed = applyEntry(cloned, entry)
      newState = cloned

      await appendLog(entry)

      if (changed) {
        // Check if we've crossed a UTC date anchor
        const snapshotInterval = currentSnapshot
          ? getIntervalKey(currentSnapshot.timestamp)
          : getIntervalKey(now)
        const currentInterval = getIntervalKey(now)

        if (snapshotInterval !== currentInterval && currentSnapshot) {
          await saveHistoricalSnapshot({
            timestamp: currentSnapshot.timestamp,
            state: currentSnapshot.state,
          })
          await pruneOldSnapshots(5)
        }

        await saveCurrentSnapshot({ timestamp: now, state: newState })
      }
    })

    if (changed) {
      setState(newState)
      // Trigger debounced push to Google Drive
      notifyDataChanged()
      // Prune logs if over threshold (500k), fire-and-forget
      getLogCount().then(count => {
        if (count > 500_000) pruneOldestLogs(1000)
      }).catch(err => {
        console.error('Log pruning failed:', err)
      })
    }

    return changed
  }, [])

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
    await applyAndPersist(entry)
    return childId
  }, [applyAndPersist])

  const updateChild = useCallback(async (childId: string, updates: { name?: string; wordBookId?: string }) => {
    const entry: UpdateChildEntry = {
      timestamp: generateTimestamp(),
      type: 'update_child',
      childId,
      ...updates,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

  const deleteChild = useCallback(async (childId: string) => {
    const entry: DeleteChildEntry = {
      timestamp: generateTimestamp(),
      type: 'delete_child',
      childId,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

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
    await applyAndPersist(entry)
    return wordBookId
  }, [applyAndPersist])

  const updateWordBook = useCallback(async (wordBookId: string, name: string) => {
    const entry: UpdateWordBookEntry = {
      timestamp: generateTimestamp(),
      type: 'update_wordbook',
      wordBookId,
      name,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

  const deleteWordBook = useCallback(async (wordBookId: string) => {
    const entry: DeleteWordBookEntry = {
      timestamp: generateTimestamp(),
      type: 'delete_wordbook',
      wordBookId,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

  const addCharacter = useCallback(async (wordBookId: string, character: string) => {
    // Validate BEFORE persisting so errors propagate to the caller.
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

    // Eagerly update the ref so that sequential calls within the same
    // microtask (e.g. a batch addCharacter loop) see each other's
    // additions for validation and correct index assignment.
    wordBooksRef.current = wordBooksRef.current.map(w =>
      w.id === wordBookId
        ? { ...w, characters: [...w.characters, character] }
        : w
    )

    await applyAndPersist(entry)
  }, [applyAndPersist])

  const removeCharacter = useCallback(async (wordBookId: string, character: string, index: number) => {
    const entry: RemoveCharEntry = {
      timestamp: generateTimestamp(),
      type: 'remove_char',
      wordBookId,
      character,
      index,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

  const reorderCharacters = useCallback(async (wordBookId: string, characters: string[]) => {
    const entry: ReorderCharsEntry = {
      timestamp: generateTimestamp(),
      type: 'reorder_chars',
      wordBookId,
      characters,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

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
    // applyAndPersist handles snapshot update (round 1 only) + React state
    await applyAndPersist(entry)
  }, [applyAndPersist])

  const submitPresentChars = useCallback(async (
    childId: string,
    characters: string[],
    dayKey: string,
  ) => {
    const entry: PresentCharsEntry = {
      timestamp: generateTimestamp(),
      type: 'present_chars',
      childId,
      characters,
      dayKey,
    }
    // applyEntry 返回 false，不触发快照更新，仅写日志
    await applyAndPersist(entry)
  }, [applyAndPersist])

  // ---- Settings Operations ----

  const updateSettings = useCallback(async (settings: Partial<Settings>) => {
    const entry: UpdateSettingsEntry = {
      timestamp: generateTimestamp(),
      type: 'update_settings',
      settings,
    }
    await applyAndPersist(entry)
  }, [applyAndPersist])

  // ---- Data Management ----

  const getLogEntries = useCallback(async (): Promise<AnyLogEntry[]> => {
    // Collect all log entries using Dexie cursor.
    // Note: this still loads all entries into memory — prefer sharded
    // reads for large datasets. Used for user-initiated export.
    const result: AnyLogEntry[] = []
    await db.logs.orderBy('timestamp').each(entry => {
      result.push(entry)
    })
    return result
  }, [])

  const bulkImport = useCallback(async (
    snapshot: { timestamp: number; state: AppState },
    logs: AnyLogEntry[],
  ): Promise<void> => {
    // 1. Apply all log entries to the snapshot state for the canonical view
    const newState = deepCloneState(snapshot.state)
    for (const entry of logs) {
      applyEntry(newState, entry)
    }

    // 2. Save the merged snapshot as current
    await saveCurrentSnapshot({ timestamp: Date.now(), state: newState })

    // 3. Append all log entries
    if (logs.length > 0) {
      await appendLogs(logs)
    }

    // 4. Update React state
    setState(newState)

    // 5. Trigger sync to push imported data to Drive
    notifyDataChanged()
  }, [])

  return (
    <AppContext.Provider
      value={{
        state,
        loading,
        dataVersion,
        selectedChildId,
        setSelectedChildId,
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
        submitPresentChars,
        updateSettings,
        getLogEntries,
        bulkImport,
        reloadState,
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
