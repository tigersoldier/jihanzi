import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { Grade, SM2State, ReviewEntry } from '../core/types'
import { useApp } from '../state/AppContext'
import { getReviewsForChildCharPaginated, getReviewsForChildInRange } from '../data/db'
import { getDayType } from '../utils/date'

export { type Proficiency, getProficiency, PROFICIENCY_COLORS, PROFICIENCY_DOT } from '../core/proficiency'

// ============================================================
// Character stats
// ============================================================

/** 时间线每页条数（多取 1 条用于判断 hasMore） */
const TIMELINE_PAGE_SIZE = 51

export interface CharacterStats {
  sm2State: SM2State | undefined
  totalReviews: number
  gradeCounts: { a: number; b: number; c: number; d: number }
  /** Review timeline grouped by day, most recent first — 分批加载 */
  timeline: {
    dayKey: string
    rounds: { round: number; grade: Grade }[]
  }[]
  /** 正在从 IndexedDB 加载首页数据 */
  loading: boolean
  /** 还有更早的历史可以加载 */
  hasMore: boolean
  /** 正在加载更早的页面 */
  loadingMore: boolean
  /** 触发加载更早的页面 */
  loadMore: () => void
}

/** 将 review entries 按 dayKey 分组、排序为 timeline */
function entriesToTimeline(entries: ReviewEntry[]): CharacterStats['timeline'] {
  const dayMap = new Map<string, { round: number; grade: Grade }[]>()
  for (const entry of entries) {
    if (entry.type !== 'review') continue
    const day = dayMap.get(entry.dayKey) || []
    day.push({ round: entry.round, grade: entry.grade })
    dayMap.set(entry.dayKey, day)
  }
  // Sort rounds within each day
  for (const rounds of dayMap.values()) {
    rounds.sort((a, b) => a.round - b.round)
  }
  // Most recent days first
  return Array.from(dayMap.entries())
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([dayKey, rounds]) => ({ dayKey, rounds }))
}

/** 将新页的 timeline 合并到已有 timeline 末尾（新页是更早的数据） */
function mergeTimeline(
  existing: CharacterStats['timeline'],
  more: CharacterStats['timeline'],
): CharacterStats['timeline'] {
  const existingKeys = new Set(existing.map(d => d.dayKey))
  const newDays = more.filter(d => !existingKeys.has(d.dayKey))
  return [...existing, ...newDays]
}

export function useCharacterStats(childId: string, character: string): CharacterStats {
  const { state, dataVersion } = useApp()
  const [gradeCounts, setGradeCounts] = useState({ a: 0, b: 0, c: 0, d: 0 })
  const [totalReviews, setTotalReviews] = useState(0)
  const [timeline, setTimeline] = useState<CharacterStats['timeline']>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const cursorRef = useRef<number | undefined>(undefined)
  const loadingMoreRef = useRef(false)

  const sm2State = useMemo(() => {
    const child = state.children.find(c => c.id === childId)
    return child?.progress[character]
  }, [state.children, childId, character])

  // sm2State 是对象引用，immutable state 下每次状态更新都会变。
  // 用 JSON 字符串做依赖，按值比较，值不变就不会触发 effect 重跑。
  const sm2Key = useMemo(() => sm2State ? JSON.stringify(sm2State) : '', [sm2State])

  // 首次加载：timeline 首页（分页，只读最多 51 条），counts 从首页数据统计
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    cursorRef.current = undefined

    async function load() {
      // 首页用分页查询，只物化最多 51 条记录
      const page = await getReviewsForChildCharPaginated(childId, character, TIMELINE_PAGE_SIZE)
      if (cancelled) return

      // 从首页数据统计 grade 分布（不保证完整，仅展示已加载部分）
      const counts = { a: 0, b: 0, c: 0, d: 0 }
      for (const entry of page.entries) {
        counts[entry.grade as Grade]++
      }
      setGradeCounts(counts)
      setTotalReviews(page.entries.length)

      setTimeline(entriesToTimeline(page.entries))
      setHasMore(page.hasMore)
      cursorRef.current = page.cursor ?? undefined
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [childId, character, sm2Key])

  // 加载更早的页面
  const loadMore = useCallback(() => {
    if (loadingMoreRef.current || !hasMore) return
    loadingMoreRef.current = true
    setLoadingMore(true)

    getReviewsForChildCharPaginated(childId, character, TIMELINE_PAGE_SIZE, cursorRef.current)
      .then(page => {
        setTimeline(prev => mergeTimeline(prev, entriesToTimeline(page.entries)))
        setHasMore(page.hasMore)
        cursorRef.current = page.cursor ?? undefined
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
      .catch(() => {
        loadingMoreRef.current = false
        setLoadingMore(false)
      })
  }, [childId, character, hasMore])

  return { sm2State, totalReviews, gradeCounts, timeline, loading, hasMore, loadingMore, loadMore }
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

function currentYearMonth(): string {
  return new Date().toISOString().slice(0, 7)
}

export function useHistory(childId: string, yearMonth: string): MonthHistory {
  const { state, dataVersion } = useApp()
  const [days, setDays] = useState<DaySummary[]>([])

  // Past months are immutable — skip the full historical scan on
  // dataVersion bumps when the viewed month hasn't changed.
  const lastFetch = useRef<{ ym: string; dv: number; child: string } | null>(null)

  useEffect(() => {
    let cancelled = false

    const isCurrentMonth = yearMonth === currentYearMonth()
    const sameParams = lastFetch.current
      && lastFetch.current.ym === yearMonth
      && lastFetch.current.child === childId

    // For past months, skip the entire load when only dataVersion
    // changed — past-month review data is immutable.
    if (sameParams && !isCurrentMonth) {
      lastFetch.current = { ym: yearMonth, dv: dataVersion, child: childId }
      return
    }

    async function load() {
      lastFetch.current = { ym: yearMonth, dv: dataVersion, child: childId }

      const totalDays = daysInMonth(yearMonth)
      const fromDay = toDayKey(yearMonth, 1)
      const toDay = toDayKey(yearMonth, totalDays)

      const entries = await getReviewsForChildInRange(childId, fromDay, toDay)
      if (cancelled) return

      // Resolve child from snapshot state for firstReviewDay lookups
      const child = state.children.find(c => c.id === childId)

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
            stats[entry.grade as keyof typeof stats]++
          }
        }

        // Classify new vs review using firstReviewDay from snapshot
        for (const [character, grade] of charRound1) {
          const sm2 = child?.progress[character]
          if (sm2?.firstReviewDay === dayKey) {
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
  }, [childId, yearMonth, dataVersion, state])

  return { yearMonth, days }
}
