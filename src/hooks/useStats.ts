import { useState, useEffect, useMemo } from 'react'
import type { Grade, SM2State } from '../core/types'
import { useApp } from '../state/AppContext'
import { getReviewsForChildChar, getReviewsForChildInRange, getFirstReviewDays } from '../data/db'
import { getDayType } from '../utils/date'

// ============================================================
// Proficiency helpers
// ============================================================

export type Proficiency = 'mastered' | 'progressing' | 'weak' | 'unlearned'

export function getProficiency(sm2State: SM2State | undefined): Proficiency {
  if (!sm2State) return 'unlearned'
  if (sm2State.lastGrade === 'a' && sm2State.repetitions >= 3) return 'mastered'
  if (sm2State.lastGrade === 'd' || (sm2State.lastGrade === 'c' && sm2State.repetitions < 2)) return 'weak'
  return 'progressing'
}

export const PROFICIENCY_COLORS: Record<Proficiency, string> = {
  mastered: 'bg-green-100 text-green-700 border-green-300',
  progressing: 'bg-blue-100 text-blue-700 border-blue-300',
  weak: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  unlearned: 'bg-gray-100 text-gray-400 border-gray-200',
}

export const PROFICIENCY_DOT: Record<Proficiency, string> = {
  mastered: '🟢',
  progressing: '🔵',
  weak: '🟡',
  unlearned: '⚪',
}

// ============================================================
// Character stats
// ============================================================

export interface CharacterStats {
  sm2State: SM2State | undefined
  totalReviews: number
  gradeCounts: { a: number; b: number; c: number; d: number }
  /** Review timeline grouped by day, most recent first */
  timeline: {
    dayKey: string
    rounds: { round: number; grade: Grade }[]
  }[]
}

export function useCharacterStats(childId: string, character: string): CharacterStats {
  const { state, dataVersion } = useApp()
  const [gradeCounts, setGradeCounts] = useState({ a: 0, b: 0, c: 0, d: 0 })
  const [totalReviews, setTotalReviews] = useState(0)
  const [timeline, setTimeline] = useState<CharacterStats['timeline']>([])

  const sm2State = useMemo(() => {
    const child = state.children.find(c => c.id === childId)
    return child?.progress[character]
  }, [state.children, childId, character])

  useEffect(() => {
    let cancelled = false

    async function load() {
      const entries = await getReviewsForChildChar(childId, character)
      if (cancelled) return

      const counts = { a: 0, b: 0, c: 0, d: 0 }
      const dayMap = new Map<string, { round: number; grade: Grade }[]>()

      for (const entry of entries) {
        if (entry.type !== 'review') continue
        counts[entry.grade as Grade]++
        const day = dayMap.get(entry.dayKey) || []
        day.push({ round: entry.round, grade: entry.grade })
        dayMap.set(entry.dayKey, day)
      }

      // Sort rounds within each day
      for (const rounds of dayMap.values()) {
        rounds.sort((a, b) => a.round - b.round)
      }

      // Most recent days first
      const sortedTimeline = Array.from(dayMap.entries())
        .sort(([a], [b]) => b.localeCompare(a))
        .map(([dayKey, rounds]) => ({ dayKey, rounds }))

      setGradeCounts(counts)
      setTotalReviews(entries.length)
      setTimeline(sortedTimeline)
    }

    load()
    return () => { cancelled = true }
  }, [childId, character, dataVersion])

  return { sm2State, totalReviews, gradeCounts, timeline }
}

// ============================================================
// Monthly history
// ============================================================

export interface DaySummary {
  dayKey: string
  dayType: 'learn' | 'review'
  newChars: { character: string; grade: Grade }[]
  reviewChars: { character: string; grade: Grade }[]
  /** Round 1 grade distribution for this day */
  stats: { a: number; b: number; c: number; d: number }
  totalCount: number
}

export interface MonthHistory {
  yearMonth: string
  days: DaySummary[]
}

function daysInMonth(yearMonth: string): number {
  const [year, month] = yearMonth.split('-').map(Number)
  return new Date(year, month, 0).getDate()
}

function toDayKey(yearMonth: string, day: number): string {
  const [year, month] = yearMonth.split('-')
  return `${year}-${month}-${String(day).padStart(2, '0')}`
}

export function useHistory(childId: string, yearMonth: string): MonthHistory {
  const { dataVersion } = useApp()
  const [days, setDays] = useState<DaySummary[]>([])

  useEffect(() => {
    let cancelled = false

    async function load() {
      const totalDays = daysInMonth(yearMonth)
      const fromDay = toDayKey(yearMonth, 1)
      const toDay = toDayKey(yearMonth, totalDays)

      const [entries, firstReviewDays] = await Promise.all([
        getReviewsForChildInRange(childId, fromDay, toDay),
        getFirstReviewDays(childId),
      ])
      if (cancelled) return

      // Group reviews by dayKey
      const dayMap = new Map<string, typeof entries>()
      for (const entry of entries) {
        if (entry.type !== 'review') continue
        const list = dayMap.get(entry.dayKey) || []
        list.push(entry)
        dayMap.set(entry.dayKey, list)
      }

      const summaries: DaySummary[] = []

      // Iterate days in reverse so most recent first
      for (let d = totalDays; d >= 1; d--) {
        const dayKey = toDayKey(yearMonth, d)
        const dayEntries = dayMap.get(dayKey)
        if (!dayEntries || dayEntries.length === 0) continue

        const newChars: DaySummary['newChars'] = []
        const reviewChars: DaySummary['reviewChars'] = []
        const stats = { a: 0, b: 0, c: 0, d: 0 }

        // Collect round 1 grades per character for this day
        const charRound1 = new Map<string, Grade>()
        for (const entry of dayEntries) {
          if (entry.round === 1) {
            charRound1.set(entry.character, entry.grade)
            stats[entry.grade]++
          }
        }

        // Classify new vs review using all-time first-review days
        for (const [character, grade] of charRound1) {
          const firstDay = firstReviewDays.get(character)
          if (firstDay === dayKey) {
            newChars.push({ character, grade })
          } else {
            reviewChars.push({ character, grade })
          }
        }

        summaries.push({
          dayKey,
          dayType: getDayType(dayKey),
          newChars,
          reviewChars,
          stats,
          totalCount: charRound1.size,
        })
      }

      setDays(summaries)
    }

    load()
    return () => { cancelled = true }
  }, [childId, yearMonth, dataVersion])

  return { yearMonth, days }
}
