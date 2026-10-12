import { useEffect, useMemo, useState } from 'react'
import type { SM2State } from '../core/types'
import {
  classifyCharacters,
  buildHistoricalCharts,
  simulateSevenDayForecast,
} from '../core/learningAnalytics'
import type { CharacterClassification, HistoricalCharts } from '../core/learningAnalytics'
import {
  backfillLearningAnalytics,
  getAnalyticsBackfillStatus,
  getCharacterAnalyticsForChild,
  getDailyReviewStatsForDay,
  getDailyReviewStatsInRange,
  type AnalyticsBackfillStatus,
} from '../data/db'
import { useApp } from '../state/AppContext'
import { todayKey } from '../utils/date'

const EMPTY_PROGRESS: Record<string, SM2State> = {}

export interface LearningAnalyticsView {
  loading: boolean
  error: boolean
  backfill: AnalyticsBackfillStatus
  charts: HistoricalCharts
  characters: CharacterClassification[]
  forecast: ReturnType<typeof simulateSevenDayForecast>
}

function chartRange(yearMonth: string): { from: string; to: string } {
  const [year, month] = yearMonth.split('-').map(Number)
  const first = new Date(Date.UTC(year, month - 1, 1))
  const last = new Date(Date.UTC(year, month, 0))
  const monday = new Date(first)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  const sunday = new Date(last)
  sunday.setUTCDate(sunday.getUTCDate() + ((7 - ((sunday.getUTCDay() + 6) % 7)) % 7))
  const start = monday.toISOString().slice(0, 10)
  const end = sunday.toISOString().slice(0, 10)
  return {
    from: start < `${year}-01-01` ? start : `${year}-01-01`,
    to: end > `${year}-12-31` ? end : `${year}-12-31`,
  }
}

export function useLearningAnalytics(childId: string, yearMonth: string): LearningAnalyticsView {
  const { state, dataVersion } = useApp()
  const child = state.children.find(item => item.id === childId)
  const progress = child?.progress ?? EMPTY_PROGRESS
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [backfill, setBackfill] = useState<AnalyticsBackfillStatus>({
    ready: false,
    processed: 0,
    total: 0,
    phase: 'facts',
  })
  const [dailyRows, setDailyRows] = useState<
    Awaited<ReturnType<typeof getDailyReviewStatsInRange>>
  >([])
  const [characterRows, setCharacterRows] = useState<
    Awaited<ReturnType<typeof getCharacterAnalyticsForChild>>
  >([])
  const [todayCompleted, setTodayCompleted] = useState(0)
  const today = todayKey()
  const range = chartRange(yearMonth)

  useEffect(() => {
    let cancelled = false
    if (!childId) {
      setLoading(false)
      setBackfill({ ready: true, processed: 0, total: 0, phase: 'logs' })
      return () => {
        cancelled = true
      }
    }

    setLoading(true)
    setError(false)
    async function load() {
      try {
        const initial = await getAnalyticsBackfillStatus()
        if (cancelled) return
        setBackfill(initial)
        await backfillLearningAnalytics(status => {
          if (!cancelled) setBackfill(status)
        })
        if (cancelled) return
        const [daily, characters, todayStats, finishedBackfill] = await Promise.all([
          getDailyReviewStatsInRange(childId, range.from, range.to),
          getCharacterAnalyticsForChild(childId),
          getDailyReviewStatsForDay(childId, today),
          getAnalyticsBackfillStatus(),
        ])
        if (cancelled) return
        setDailyRows(daily)
        setCharacterRows(characters)
        setTodayCompleted(
          todayStats
            ? Object.values(todayStats.learnedChars).reduce((sum, count) => sum + count, 0)
            : 0,
        )
        setBackfill(finishedBackfill)
      } catch (e) {
        console.error('Learning analytics load failed:', e)
        if (!cancelled) setError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [childId, yearMonth, range.from, range.to, dataVersion, progress, today])

  const charts = useMemo(() => buildHistoricalCharts(yearMonth, dailyRows), [yearMonth, dailyRows])
  const characters = useMemo(
    () => classifyCharacters(progress, characterRows),
    [progress, characterRows],
  )
  const forecast = useMemo(
    () =>
      simulateSevenDayForecast(progress, state.settings.dailyReviewLimit, today, todayCompleted),
    [progress, state.settings.dailyReviewLimit, today, todayCompleted],
  )

  return { loading, error, backfill, charts, characters, forecast }
}
