import { useState, useCallback, useMemo, useRef, useEffect } from 'react'
import type { TaskItem, Grade, ReviewEntry } from '../core/types'
import { useApp } from '../state/AppContext'
import { generateTodayTasks } from '../core/scheduler'
import { todayKey as getTodayKey, getDayType, getDayTypeLabel, formatDateLabel } from '../utils/date'

export type SessionPhase = 'idle' | 'reviewing' | 'roundComplete' | 'celebration'

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
}

function sessionKey(childId: string, dayKey: string): string {
  return `${SESSION_KEY_PREFIX}${childId}_${dayKey}`
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
  startSession: () => void
  handleContinueRound: () => void
  handleSkipRound: () => void
  handleDone: () => void
  isReady: boolean
}

export function useToday(): UseTodayReturn {
  const { state, submitReview } = useApp()
  const todayKey = getTodayKey()
  const dayType = getDayType(todayKey)
  const dayTypeLabel = getDayTypeLabel(dayType)
  const dateLabel = formatDateLabel(todayKey)

  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [taskIndex, setTaskIndex] = useState(0)
  const [round, setRound] = useState(1)
  const [selectedChildId, setSelectedChildId] = useState<string>(
    () => state.children[0]?.id || ''
  )
  const [sessionReviews, setSessionReviews] = useState<ReviewEntry[]>([])
  const [sessionStats, setSessionStats] = useState({ a: 0, b: 0, c: 0, d: 0 })
  const [ratingAnimation, setRatingAnimation] = useState<string | null>(null)
  // Snapshot of tasks captured at session start. Prevents task list
  // from shifting when state changes mid-session (e.g. submitReview
  // advances nextCharIndex, which would otherwise regenerate the list).
  const [sessionTasks, setSessionTasks] = useState<TaskItem[] | null>(null)
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
        return
      }
    }

    // Mark as done so we don't keep trying on every render
    didRestore.current = true
  }, [state.children, selectedChildId, todayKey])

  // Auto-select the first child when children become available after
  // async IndexedDB load. The useState initializer (line 85-87) runs
  // during the first render when state.children may still be empty;
  // this effect fills the gap.
  useEffect(() => {
    if (state.children.length > 0 && !selectedChildId) {
      setSelectedChildId(state.children[0].id)
    }
  }, [state.children, selectedChildId])

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
    })
  }, [phase, taskIndex, round, sessionTasks, sessionReviews, sessionStats, selectedChildId, todayKey, state.children])

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

  const startSession = useCallback(() => {
    const currentTasks = tasksRef.current
    if (currentTasks.length === 0) return
    // Clear any stale saved session before starting a new one
    clearSession(selectedChildId, todayKey)
    setSessionTasks([...currentTasks])  // snapshot so it won't shift mid-session
    setPhase('reviewing')
    setTaskIndex(0)
    setRound(1)
    setSessionReviews([])
    setSessionStats({ a: 0, b: 0, c: 0, d: 0 })
  }, [selectedChildId, todayKey])

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
    setPhase('idle')
    setTaskIndex(0)
    setRound(1)
    setSessionTasks(null)  // clear session snapshot
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
    startSession,
    handleContinueRound,
    handleSkipRound,
    handleDone,
    isReady: selectedChildId !== '' && effectiveTasks.length > 0,
  }
}
