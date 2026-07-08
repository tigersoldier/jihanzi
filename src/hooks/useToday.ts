import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { TaskItem, Grade, ReviewEntry, AppState } from '../core/types'
import { useApp } from '../state/AppContext'
import { generateTodayTasks } from '../core/scheduler'
import { todayKey as getTodayKey, addDays, getDayType, getDayTypeLabel, formatDateLabel } from '../utils/date'
import { getReviewsForChildOnDay } from '../data/db'

export type SessionPhase = 'idle' | 'presenting' | 'reviewing' | 'roundComplete' | 'celebration'

// ---- Session persistence (localStorage) ----

const SESSION_KEY_PREFIX = 'jihanzi_session_'

interface SavedSession {
  childId: string
  dayKey: string
  phase: SessionPhase
  taskIndex: number
  round: number
  sessionTasks: TaskItem[]
  sessionReviews: ReviewEntry[]
  sessionStats: { a: number; b: number; c: number; d: number }
  queuedReviewTasks: TaskItem[]
}

function sessionKey(childId: string, dayKey: string): string {
  return `${SESSION_KEY_PREFIX}${childId}_${dayKey}`
}

const DONE_KEY_PREFIX = 'jihanzi_done_'

function doneKey(childId: string, dayKey: string): string {
  return `${DONE_KEY_PREFIX}${childId}_${dayKey}`
}

function isDayDone(childId: string, dayKey: string): boolean {
  try {
    return localStorage.getItem(doneKey(childId, dayKey)) === '1'
  } catch {
    return false
  }
}

function markDayDone(childId: string, dayKey: string): void {
  try {
    localStorage.setItem(doneKey(childId, dayKey), '1')
  } catch {
    // ignore
  }
}

function loadSession(childId: string, dayKey: string): SavedSession | null {
  try {
    const raw = localStorage.getItem(sessionKey(childId, dayKey))
    if (!raw) return null
    return JSON.parse(raw) as SavedSession
  } catch {
    return null
  }
}

function saveSession(childId: string, dayKey: string, data: SavedSession): void {
  try {
    localStorage.setItem(sessionKey(childId, dayKey), JSON.stringify(data))
  } catch {
    // localStorage full or disabled — silently ignore
  }
}

function clearSession(childId: string, dayKey: string): void {
  try {
    localStorage.removeItem(sessionKey(childId, dayKey))
  } catch {
    // ignore
  }
}

interface UseTodayReturn {
  phase: SessionPhase
  dayType: string
  dateLabel: string
  currentTask: TaskItem | null
  taskIndex: number
  totalTasks: number
  round: number
  sessionStats: { a: number; b: number; c: number; d: number }
  ratingAnimation: string | null
  selectedChildId: string
  children: { id: string; name: string; hasTasks: boolean }[]
  setSelectedChildId: (id: string) => void
  handleRate: (grade: Grade) => void
  handlePresentNav: (direction: 'prev' | 'next') => void
  startSession: () => void
  handleContinueRound: () => void
  handleSkipRound: () => void
  handleDone: () => void
  isReady: boolean
  doneToday: boolean
  todayNewChars: string[]
  todayReviewChars: string[]
  tomorrowDayType: string
  tomorrowNewChars: string[]
  tomorrowReviewChars: string[]
}

export function useToday(): UseTodayReturn {
  const { state, submitReview, submitPresentChars, selectedChildId, setSelectedChildId, dataVersion } = useApp()
  const todayKey = getTodayKey()
  const dayType = getDayType(todayKey)
  const dayTypeLabel = getDayTypeLabel(dayType)
  const dateLabel = formatDateLabel(todayKey)
  const tomorrowKey = addDays(todayKey, 1)

  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [taskIndex, setTaskIndex] = useState(0)
  const [round, setRound] = useState(1)
  const [sessionReviews, setSessionReviews] = useState<ReviewEntry[]>([])
  const [sessionStats, setSessionStats] = useState({ a: 0, b: 0, c: 0, d: 0 })
  const [ratingAnimation, setRatingAnimation] = useState<string | null>(null)
  // Snapshot of tasks captured at session start. Prevents task list
  // from shifting when state changes mid-session (e.g. submitReview
  // advances nextCharIndex, which would otherwise regenerate the list).
  const [sessionTasks, setSessionTasks] = useState<TaskItem[] | null>(null)
  // 展示阶段：queuedReviewTasks = 到期复习字排队列表，sessionTasks 同时充当展示队列（新字）
  const [queuedReviewTasks, setQueuedReviewTasks] = useState<TaskItem[]>([])
  const [doneToday, setDoneToday] = useState(false)
  const advancingRef = useRef(false)
  const continuingRef = useRef(false)
  // Ref mirror of tasks so startSession can read the latest task list
  // without depending on the full array reference.
  const tasksRef = useRef<TaskItem[]>([])
  // Track whether we've already attempted session restoration from
  // localStorage (runs once after IndexedDB state is loaded).
  const didRestore = useRef(false)

  // Restore saved session after IndexedDB state is loaded (page refresh).
  // Runs when state.children becomes non-empty (i.e. after AppContext
  // finishes its async load from IndexedDB).
  useEffect(() => {
    if (didRestore.current) return
    if (state.children.length === 0) return

    // Try the currently-selected child first, then fall back to searching
    // all children for a saved session. This handles multi-child setups
    // where the user was reviewing a non-first child before refresh.
    const candidateIds = selectedChildId
      ? [selectedChildId, ...state.children.map(c => c.id).filter(id => id !== selectedChildId)]
      : state.children.map(c => c.id)

    for (const childId of candidateIds) {
      const saved = loadSession(childId, todayKey)
      if (saved && saved.dayKey === todayKey && saved.phase !== 'idle') {
        didRestore.current = true
        setPhase(saved.phase)
        setTaskIndex(saved.taskIndex)
        setRound(saved.round)
        setSelectedChildId(saved.childId)
        setSessionReviews(saved.sessionReviews)
        setSessionStats(saved.sessionStats)
        setSessionTasks(saved.sessionTasks)
        setQueuedReviewTasks(saved.queuedReviewTasks || [])
        return
      }
    }

    // Mark as done so we don't keep trying on every render
    didRestore.current = true
  }, [state.children, selectedChildId, todayKey])

  // Check whether today's session was already completed (survives page
  // refresh).  Runs once after IndexedDB state is loaded, and whenever
  // the selected child changes.
  useEffect(() => {
    if (state.children.length === 0) return
    const childId = selectedChildId || state.children[0]?.id
    if (!childId) return
    setDoneToday(isDayDone(childId, todayKey))
  }, [state.children, selectedChildId, todayKey])

  // Persist session state to localStorage whenever it changes.
  useEffect(() => {
    const childId = selectedChildId || state.children[0]?.id
    if (!childId || phase === 'idle' || !sessionTasks) return

    saveSession(childId, todayKey, {
      childId,
      dayKey: todayKey,
      phase,
      taskIndex,
      round,
      sessionTasks,
      sessionReviews,
      sessionStats,
      queuedReviewTasks,
    })
  }, [phase, taskIndex, round, sessionTasks, sessionReviews, sessionStats, queuedReviewTasks, selectedChildId, todayKey, state.children])

  // ---- Sync-driven doneToday check ----

  /**
   * 同步拉取到远程复习日志后，检查当日复习是否达标。
   * 达标条件：去重复习字（firstReviewDay !== todayKey）数 >= min(限额, 到期数)。
   * 仅在 idle 态执行，不打断进行中的学习会话。
   */
  async function checkAndMarkDone(childId: string, dayKey: string, currentState: AppState) {
    try {
      // 1. 查 IndexedDB 中当日 round 1 复习日志
      const reviews = await getReviewsForChildOnDay(childId, dayKey)

      // 2. 去重 + 只数复习字（firstReviewDay !== dayKey 的是复习，等于的是新学）
      const child = currentState.children.find(c => c.id === childId)
      if (!child) return
      const reviewedChars = new Set(reviews.map(r => r.character))
      let reviewCount = 0
      for (const char of reviewedChars) {
        const sm2 = child.progress[char]
        if (sm2 && sm2.firstReviewDay !== dayKey) reviewCount++
      }
      if (reviewCount === 0) return

      // 3. 算当日到期复习字数
      const tasks = generateTodayTasks(currentState, childId, dayKey)
      const dueReviewCount = tasks.filter(t => t.isReview).length

      // 4. 达标判定
      const threshold = Math.min(currentState.settings.dailyReviewLimit, dueReviewCount)
      if (reviewCount >= threshold && threshold > 0) {
        clearSession(childId, dayKey)
        markDayDone(childId, dayKey)
        setDoneToday(true)
      }
    } catch {
      // IndexedDB 查询可能失败（如登出期间）——静默忽略
    }
  }

  // 每次同步合并数据后（dataVersion 递增）检查当日是否已达标
  useEffect(() => {
    if (phase !== 'idle') return
    if (state.children.length === 0) return

    const childId = selectedChildId || state.children[0]?.id
    if (!childId) return

    // 已标记完成的跳过，避免重复查 IndexedDB
    if (isDayDone(childId, todayKey)) return

    checkAndMarkDone(childId, todayKey, state)
  }, [phase, state, selectedChildId, todayKey, dataVersion])

  // Get available children
  const children = useMemo(() => {
    return state.children.map(c => ({
      id: c.id,
      name: c.name,
      hasTasks: true, // Simplified
    }))
  }, [state.children])

  // Generate tasks for the selected child (idle screen + session init).
  // Skip recomputation during an active session — sessionTasks is the
  // source of truth for task order until the session ends.
  const tasks = useMemo(() => {
    if (!selectedChildId || sessionTasks !== null) return []
    return generateTodayTasks(state, selectedChildId, todayKey)
  }, [state, selectedChildId, todayKey, sessionTasks])

  // Keep the ref in sync so startSession (which has [] deps) always
  // reads the latest tasks.
  tasksRef.current = tasks

  // Use session-locked tasks when a session is active; otherwise use
  // live tasks (for the idle-screen count).
  const effectiveTasks = sessionTasks ?? tasks

  const currentTask = effectiveTasks[taskIndex] || null
  const totalTasks = effectiveTasks.length

  // 今日任务按新学/复习分组（idle 预览用）
  const todayNewChars = useMemo(() => {
    return effectiveTasks.filter(t => t.isNew).map(t => t.character)
  }, [effectiveTasks])

  const todayReviewChars = useMemo(() => {
    return effectiveTasks.filter(t => t.isReview).map(t => t.character)
  }, [effectiveTasks])

  // 明日任务预览（仅在 doneToday 后需要，做 gating 避免会话期间无谓计算）
  const tomorrowTasks = useMemo(() => {
    if (!doneToday || !selectedChildId) return []
    return generateTodayTasks(state, selectedChildId, tomorrowKey)
  }, [doneToday, state, selectedChildId, tomorrowKey])

  const tomorrowNewChars = useMemo(() => {
    return tomorrowTasks.filter(t => t.isNew).map(t => t.character)
  }, [tomorrowTasks])

  const tomorrowReviewChars = useMemo(() => {
    return tomorrowTasks.filter(t => t.isReview).map(t => t.character)
  }, [tomorrowTasks])

  const tomorrowDayType = useMemo(() => {
    return getDayTypeLabel(getDayType(tomorrowKey))
  }, [tomorrowKey])

  const startSession = useCallback(() => {
    const currentTasks = tasksRef.current
    if (currentTasks.length === 0) return
    // Clear any stale saved session before starting a new one
    clearSession(selectedChildId, todayKey)

    const reviewTasks = currentTasks.filter(t => t.isReview)
    const newTasks = currentTasks.filter(t => t.isNew)

    if (dayType === 'learn' && newTasks.length > 0) {
      // 学新日 + 有新字：先进入展示阶段
      setQueuedReviewTasks(reviewTasks)
      setSessionTasks(newTasks)
      setPhase('presenting')
    } else {
      // 纯复习日 / 生字本已学完：直接进入复习阶段
      setQueuedReviewTasks([])
      setSessionTasks([...currentTasks])
      setPhase('reviewing')
    }
    setTaskIndex(0)
    setRound(1)
    setSessionReviews([])
    setSessionStats({ a: 0, b: 0, c: 0, d: 0 })
  }, [selectedChildId, todayKey, dayType])

  // 展示阶段完成：合并复习队列，写 present_chars 日志，进入复习阶段
  const handlePresentComplete = useCallback(() => {
    // sessionTasks 在展示阶段即为新字列表，先提取字符再覆盖
    const newChars = sessionTasks!.map(t => t.character)
    const mergedTasks = [...queuedReviewTasks, ...sessionTasks!]
    setSessionTasks(mergedTasks)
    setQueuedReviewTasks([])
    setTaskIndex(0)
    setPhase('reviewing')

    // 写 present_chars 审计日志（fire-and-forget，不影响状态）
    submitPresentChars(selectedChildId!, newChars, todayKey).catch(() => {})
  }, [queuedReviewTasks, sessionTasks, selectedChildId, todayKey, submitPresentChars])

  // 展示阶段导航：上一个 / 下一个（末尾字触发 handlePresentComplete）
  const handlePresentNav = useCallback((direction: 'prev' | 'next') => {
    // 仅在展示阶段有效，防止在其他阶段被误调用
    if (phase !== 'presenting') return
    if (direction === 'prev' && taskIndex > 0) {
      setTaskIndex(prev => prev - 1)
    } else if (direction === 'next') {
      if (taskIndex + 1 < totalTasks) {
        setTaskIndex(prev => prev + 1)
      } else {
        handlePresentComplete()
      }
    }
  }, [taskIndex, totalTasks, handlePresentComplete, phase])

  const handleRate = useCallback((grade: Grade) => {
    if (!currentTask || !selectedChildId) return
    // Guard against rapid double-clicks — advancingRef is true while
    // a previous rating's task-advancement timeout is still pending.
    if (advancingRef.current) return

    // Show rating animation
    setRatingAnimation(grade)
    setTimeout(() => setRatingAnimation(null), 300)

    // Update session stats
    setSessionStats(prev => ({ ...prev, [grade]: prev[grade] + 1 }))

    // Record review
    const review: ReviewEntry = {
      timestamp: Date.now(),
      type: 'review',
      childId: selectedChildId,
      character: currentTask.character,
      grade,
      round,
      dayKey: todayKey,
    }
    setSessionReviews(prev => [...prev, review])

    // Submit to backend (only round 1 affects SM-2).
    // Errors are handled inside submitReview via try/catch.
    submitReview(selectedChildId, currentTask.character, grade, round, todayKey)

    // Advance to next task or complete round.
    // Guard with advancingRef so rapid clicks don't schedule multiple
    // concurrent timeouts (which would skip tasks).
    if (!advancingRef.current) {
      advancingRef.current = true
      setTimeout(() => {
        advancingRef.current = false
        if (taskIndex + 1 < totalTasks) {
          setTaskIndex(prev => prev + 1)
        } else {
          setPhase('roundComplete')
        }
      }, 350)
    }
  }, [currentTask, selectedChildId, round, taskIndex, totalTasks, todayKey, submitReview])

  const handleContinueRound = useCallback(() => {
    // Guard against rapid double-clicks
    if (continuingRef.current) return
    continuingRef.current = true

    const cdChars = sessionReviews
      .filter(r => r.round === round && (r.grade === 'c' || r.grade === 'd'))
      .map(r => r.character)

    if (cdChars.length === 0) {
      setPhase('celebration')
      continuingRef.current = false
      return
    }

    // Filter sessionTasks to only the characters that need re-review
    const cdTasks = effectiveTasks.filter(t => cdChars.includes(t.character))
    setSessionTasks(cdTasks)
    setRound(prev => prev + 1)
    setTaskIndex(0)
    setPhase('reviewing')
    continuingRef.current = false
  }, [sessionReviews, round, effectiveTasks])

  const handleSkipRound = useCallback(() => {
    setPhase('celebration')
  }, [])

  const handleDone = useCallback(() => {
    clearSession(selectedChildId, todayKey)
    markDayDone(selectedChildId, todayKey)
    setDoneToday(true)
    setPhase('idle')
    setTaskIndex(0)
    setRound(1)
    setSessionTasks(null)  // clear session snapshot
    setQueuedReviewTasks([])
    setSessionReviews([])
    setSessionStats({ a: 0, b: 0, c: 0, d: 0 })
  }, [selectedChildId, todayKey])

  return {
    phase,
    dayType: dayTypeLabel,
    dateLabel,
    currentTask,
    taskIndex,
    totalTasks,
    round,
    sessionStats,
    ratingAnimation,
    selectedChildId,
    children,
    setSelectedChildId,
    handleRate,
    handlePresentNav,
    startSession,
    handleContinueRound,
    handleSkipRound,
    handleDone,
    isReady: selectedChildId !== '' && effectiveTasks.length > 0 && !doneToday,
    doneToday,
    todayNewChars,
    todayReviewChars,
    tomorrowDayType,
    tomorrowNewChars,
    tomorrowReviewChars,
  }
}
