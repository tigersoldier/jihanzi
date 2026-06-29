import { useState, useCallback, useMemo } from 'react'
import type { TaskItem, Grade, ReviewEntry } from '../core/types'
import { useApp } from '../state/AppContext'
import { generateTodayTasks } from '../core/scheduler'
import { todayKey as getTodayKey, getDayType, getDayTypeLabel, formatDateLabel } from '../utils/date'

export type SessionPhase = 'idle' | 'reviewing' | 'roundComplete' | 'celebration'

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

  // Get available children
  const children = useMemo(() => {
    return state.children.map(c => ({
      id: c.id,
      name: c.name,
      hasTasks: true, // Simplified
    }))
  }, [state.children])

  // Generate tasks for the selected child
  const tasks = useMemo(() => {
    if (!selectedChildId) return []
    return generateTodayTasks(state, selectedChildId, todayKey)
  }, [state, selectedChildId, todayKey])

  const currentTask = tasks[taskIndex] || null
  const totalTasks = tasks.length

  const startSession = useCallback(() => {
    if (tasks.length === 0) return
    setPhase('reviewing')
    setTaskIndex(0)
    setRound(1)
    setSessionReviews([])
    setSessionStats({ a: 0, b: 0, c: 0, d: 0 })
  }, [tasks.length])

  const handleRate = useCallback((grade: Grade) => {
    if (!currentTask || !selectedChildId) return

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

    // Submit to backend (only round 1 affects SM-2)
    submitReview(selectedChildId, currentTask.character, grade, round, todayKey)
      .catch(console.error)

    // Advance to next task or complete round
    setTimeout(() => {
      if (taskIndex + 1 < tasks.length) {
        setTaskIndex(prev => prev + 1)
      } else {
        // Round complete
        setPhase('roundComplete')
      }
    }, 350)
  }, [currentTask, selectedChildId, round, taskIndex, tasks.length, todayKey, submitReview])

  const handleContinueRound = useCallback(() => {
    const cdChars = sessionReviews
      .filter(r => r.round === round && (r.grade === 'c' || r.grade === 'd'))
      .map(r => r.character)

    if (cdChars.length === 0) {
      setPhase('celebration')
      return
    }

    // Start new round with c/d characters
    setRound(prev => prev + 1)
    setTaskIndex(0)
    setPhase('reviewing')
  }, [sessionReviews, round])

  const handleSkipRound = useCallback(() => {
    setPhase('celebration')
  }, [])

  const handleDone = useCallback(() => {
    setPhase('idle')
    setTaskIndex(0)
    setRound(1)
  }, [])

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
    isReady: selectedChildId !== '' && tasks.length > 0,
  }
}
