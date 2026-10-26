import { useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import type {
  AppState,
  AnyLogEntry,
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
import { getProficiency } from '../core/proficiency'
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
  type AnalyticsReviewUpdate,
  reconstructReviewAnalyticsUpdates,
} from '../data/db'
import { getIntervalKey } from '../utils/date'
import { dedupeLogEntries, makeDiffKey } from '../utils/logKey'
import { validateAddChar } from '../utils/chars'
import { useAuth } from './AuthContextDefinition'
import { AppContext } from './AppContextDefinition'
import { notifyDataChanged, repairSnapshotProgress, salvageUnverifiableHeavy } from '../data/sync'

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
  const applyAndPersist = useCallback(async (entry: AnyLogEntry): Promise<boolean> => {
    const now = Date.now()
    let changed = false
    let reviewLogAppended = false
    let newState: AppState = EMPTY_STATE

    await db.transaction(
      'rw',
      [
        db.logs,
        db.snapshot,
        db.reviewFacts,
        db.dailyReviewStats,
        db.characterAnalytics,
        db.reviewCounts,
        db.reviewCountEvents,
        db.meta,
      ],
      async () => {
        // 在事务内读取快照，避免与其他标签页或同步流程写入快照时发生竞态。
        const currentSnapshot = await getLatestSnapshot()
        const prevState = currentSnapshot?.state || EMPTY_STATE
        const cloned = deepCloneState(prevState)
        const previousReviewState =
          entry.type === 'review'
            ? prevState.children.find(child => child.id === entry.childId)?.progress[
                entry.character
              ]
            : undefined
        const wasMastered = getProficiency(previousReviewState) === 'mastered'
        changed = applyEntry(cloned, entry)
        newState = cloned

        const updatedReviewState =
          entry.type === 'review'
            ? cloned.children.find(child => child.id === entry.childId)?.progress[entry.character]
            : undefined
        const appendedId = await appendLog(
          entry,
          entry.type === 'review'
            ? {
                isNew:
                  previousReviewState === undefined ||
                  previousReviewState.firstReviewDay === entry.dayKey,
                accepted: changed && entry.round === 1,
                wasMastered,
                isMastered: getProficiency(updatedReviewState) === 'mastered',
              }
            : undefined,
        )
        if (entry.type === 'review') {
          if (appendedId === null) {
            changed = false
            return
          }
          reviewLogAppended = true
        }

        if (changed) {
          // 检查是否跨过 UTC 日期锚点。
          const snapshotInterval = currentSnapshot
            ? getIntervalKey(currentSnapshot.timestamp)
            : getIntervalKey(now)
          const currentInterval = getIntervalKey(now)

          if (snapshotInterval !== currentInterval && currentSnapshot) {
            await saveHistoricalSnapshot({
              timestamp: currentSnapshot.timestamp,
              appliedThrough: currentSnapshot.appliedThrough,
              state: currentSnapshot.state,
            })
            await pruneOldSnapshots(5)
          }

          // 水位：本次条目的 timestamp 与保存时刻的较大者——时钟回拨时
          // 水位不回退，保证"水位之前的日志都已应用"这个不变式
          await saveCurrentSnapshot({
            timestamp: now,
            appliedThrough: Math.max(currentSnapshot?.appliedThrough ?? 0, now, entry.timestamp),
            state: newState,
          })
        }
      },
    )

    if (entry.type === 'review' && reviewLogAppended) {
      // Review rounds after the first do not change the SM-2 snapshot, but do change log-derived totals.
      setDataVersion(version => version + 1)
    }

    if (changed) {
      setState(newState)
      // Trigger debounced push to Google Drive
      notifyDataChanged()
      // Prune logs if over threshold (500k), fire-and-forget
      getLogCount()
        .then(count => (count > 500_000 ? pruneOldestLogs(1000) : undefined))
        .catch(err => {
          console.error('Log pruning failed:', err)
        })
    }

    return changed
  }, [])

  // ---- Child Operations ----

  const createChild = useCallback(
    async (name: string, wordBookId: string): Promise<string> => {
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
    },
    [applyAndPersist],
  )

  const updateChild = useCallback(
    async (childId: string, updates: { name?: string; wordBookId?: string }) => {
      const entry: UpdateChildEntry = {
        timestamp: generateTimestamp(),
        type: 'update_child',
        childId,
        ...updates,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  const deleteChild = useCallback(
    async (childId: string) => {
      const entry: DeleteChildEntry = {
        timestamp: generateTimestamp(),
        type: 'delete_child',
        childId,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  // ---- Word Book Operations ----

  const createWordBook = useCallback(
    async (name: string, characters: string[] = []): Promise<string> => {
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
    },
    [applyAndPersist],
  )

  const updateWordBook = useCallback(
    async (wordBookId: string, name: string) => {
      const entry: UpdateWordBookEntry = {
        timestamp: generateTimestamp(),
        type: 'update_wordbook',
        wordBookId,
        name,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  const deleteWordBook = useCallback(
    async (wordBookId: string) => {
      const entry: DeleteWordBookEntry = {
        timestamp: generateTimestamp(),
        type: 'delete_wordbook',
        wordBookId,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  const addCharacter = useCallback(
    async (wordBookId: string, character: string) => {
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
        w.id === wordBookId ? { ...w, characters: [...w.characters, character] } : w,
      )

      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  const removeCharacter = useCallback(
    async (wordBookId: string, character: string, index: number) => {
      const entry: RemoveCharEntry = {
        timestamp: generateTimestamp(),
        type: 'remove_char',
        wordBookId,
        character,
        index,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  const reorderCharacters = useCallback(
    async (wordBookId: string, characters: string[]) => {
      const entry: ReorderCharsEntry = {
        timestamp: generateTimestamp(),
        type: 'reorder_chars',
        wordBookId,
        characters,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  // ---- Review Operations ----

  const submitReview = useCallback(
    async (
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
    },
    [applyAndPersist],
  )

  const submitPresentChars = useCallback(
    async (childId: string, characters: string[], dayKey: string) => {
      const entry: PresentCharsEntry = {
        timestamp: generateTimestamp(),
        type: 'present_chars',
        childId,
        characters,
        dayKey,
      }
      // applyEntry 返回 false，不触发快照更新，仅写日志
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

  // ---- Settings Operations ----

  const updateSettings = useCallback(
    async (settings: Partial<Settings>) => {
      const entry: UpdateSettingsEntry = {
        timestamp: generateTimestamp(),
        type: 'update_settings',
        settings,
      }
      await applyAndPersist(entry)
    },
    [applyAndPersist],
  )

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

  const bulkImport = useCallback(
    async (
      snapshot: { timestamp: number; appliedThrough?: number; state: AppState },
      logs: AnyLogEntry[],
    ): Promise<void> => {
      // 导入前按内容去重：导出数据可能携带历史同步 bug 的重复条目，
      // 不去重会导致同一复习被多次应用、SM-2 间隔指数爆炸
      const uniqueLogs = dedupeLogEntries(logs)

      // 1. 只重放快照水位之后的日志（增量物化下快照是完整状态：
      //    快照已包含其水位之前所有日志的效果，重放它们会把
      //    同一复习重复应用——reps 翻倍、interval 指数放大（如导入
      //    20260731 数据后'途'字 3 次被算成 6 次、interval 变成 595 天））。
      //    水位之后的日志不可能已被快照包含，必须重放以补全新进度。
      const watermark = snapshot.appliedThrough ?? snapshot.timestamp
      const newState = deepCloneState(snapshot.state)
      const acceptedUpdates = new Map<AnyLogEntry, AnalyticsReviewUpdate>()
      const pendingLogs = uniqueLogs
        .filter(e => e.timestamp > watermark)
        .sort((a, b) => a.timestamp - b.timestamp)
      for (const entry of pendingLogs) {
        const previous =
          entry.type === 'review'
            ? newState.children.find(child => child.id === entry.childId)?.progress[entry.character]
            : undefined
        const wasMastered = getProficiency(previous) === 'mastered'
        const accepted = applyEntry(newState, entry)
        if (entry.type === 'review') {
          const current = newState.children.find(child => child.id === entry.childId)?.progress[
            entry.character
          ]
          acceptedUpdates.set(entry, {
            isNew: previous === undefined || previous.firstReviewDay === entry.dayKey,
            accepted: accepted && entry.round === 1,
            wasMastered,
            isMastered: getProficiency(current) === 'mastered',
          })
        }
      }

      // 2. 修订：导入旧代码产物（无 appliedThrough 水位）的快照时逐字校验修复——
      //    导出→导入迁移流程同样自愈。可验证且与日志不一致的字用重放值替换，
      //    不可验证的重污染字 8a 兑底。水位推进到并集日志的最大 timestamp。
      let appliedThrough = watermark
      if (pendingLogs.length > 0) {
        appliedThrough = Math.max(appliedThrough, pendingLogs[pendingLogs.length - 1].timestamp)
      }
      let finalState = newState
      if (snapshot.appliedThrough === undefined) {
        const { state: repaired, repaired: repairedChars } = repairSnapshotProgress(
          newState,
          uniqueLogs,
        )
        const salvaged = salvageUnverifiableHeavy(repaired, uniqueLogs)
        if (repairedChars.length > 0 || salvaged.length > 0) {
          finalState = repaired
          appliedThrough = uniqueLogs.reduce((max, e) => Math.max(max, e.timestamp), appliedThrough)
        }
      }

      const coveredOutcomes = await reconstructReviewAnalyticsUpdates(uniqueLogs, watermark)
      for (const entry of uniqueLogs) {
        if (entry.type !== 'review' || entry.round !== 1 || entry.timestamp > watermark) continue
        const outcome = coveredOutcomes.get(makeDiffKey(entry))
        if (!outcome) continue
        const firstReviewDay = finalState.children.find(child => child.id === entry.childId)
          ?.progress[entry.character]?.firstReviewDay
        acceptedUpdates.set(entry, {
          ...outcome,
          isNew: firstReviewDay === undefined || firstReviewDay === entry.dayKey,
        })
      }

      // 3. Save the merged snapshot as current
      await saveCurrentSnapshot({ timestamp: Date.now(), appliedThrough, state: finalState })

      // 4. Append all log entries（去重后的全集：同步载体 + 审计线索）
      let reviewDataChanged = false
      if (uniqueLogs.length > 0) {
        const appendResult = await appendLogs(
          uniqueLogs,
          uniqueLogs.map(entry => acceptedUpdates.get(entry)),
        )
        reviewDataChanged =
          (appendResult?.appendedCount ?? 0) > 0 || Boolean(appendResult?.projectionsChanged)
      }

      // 5. Update React state and refresh log-derived hooks after imported reviews.
      setState(finalState)
      if (reviewDataChanged) setDataVersion(version => version + 1)

      // 6. Trigger sync to push imported data to Drive
      notifyDataChanged()
    },
    [],
  )

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
