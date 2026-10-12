import type { Grade, SM2State } from './types'
import { getProficiency, type Proficiency } from './proficiency'
import { addDays } from '../utils/date'

export const GRADES: Grade[] = ['a', 'b', 'c', 'd']

export interface GradeCounts {
  a: number
  b: number
  c: number
  d: number
}

export interface CategoryCounts {
  newChars: GradeCounts
  learnedChars: GradeCounts
}

export interface DailyReviewStats extends CategoryCounts {
  childId: string
  dayKey: string
}

export interface ReviewFact {
  childId: string
  character: string
  dayKey: string
  timestamp: number
  grade: Grade
  isNew: boolean
}

export interface CharacterAnalytics {
  childId: string
  character: string
  recentLearnedFacts: Pick<ReviewFact, 'dayKey' | 'timestamp' | 'grade' | 'isNew'>[]
  everForgottenAfterMastery: boolean
  currentlyForgottenAfterMastery: boolean
  lastMasteryStatusTimestamp?: number
}

export interface HistoricalCharts {
  days: Array<{ dayKey: string; inMonth: CategoryCounts }>
  weeks: Array<{
    startDay: string
    endDay: string
    inMonth: CategoryCounts
    outsideMonth: CategoryCounts
  }>
  months: Array<{ month: number; categories: CategoryCounts }>
}

export interface CharacterClassification {
  character: string
  proficiency: Proficiency
  commonMistake: boolean
  forgottenAfterMastery: boolean
}

export interface ForecastDay {
  dayKey: string
  capacity: number
  scheduled: string[]
  remainingDue: number
}

export function emptyGradeCounts(): GradeCounts {
  return { a: 0, b: 0, c: 0, d: 0 }
}

export function emptyCategoryCounts(): CategoryCounts {
  return { newChars: emptyGradeCounts(), learnedChars: emptyGradeCounts() }
}

export function addGradeCount(target: CategoryCounts, source: CategoryCounts): void {
  for (const category of ['newChars', 'learnedChars'] as const) {
    for (const grade of GRADES) target[category][grade] += source[category][grade]
  }
}

function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function mondayKey(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return dayKey(date)
}

/** 仅按日报汇总；单次遍历输入行并分配到所有图表桶。 */
export function buildHistoricalCharts(
  yearMonth: string,
  rows: DailyReviewStats[],
): HistoricalCharts {
  const [year, month] = yearMonth.split('-').map(Number)
  const firstOfMonth = new Date(Date.UTC(year, month - 1, 1))
  const lastOfMonth = new Date(Date.UTC(year, month, 0))
  const monthStart = dayKey(firstOfMonth)
  const monthEnd = dayKey(lastOfMonth)
  const firstWeek = new Date(firstOfMonth)
  firstWeek.setUTCDate(firstWeek.getUTCDate() - ((firstWeek.getUTCDay() + 6) % 7))
  const firstWeekKey = dayKey(firstWeek)
  const lastWeekKey = mondayKey(monthEnd)
  const dailyRows = new Map(rows.map(row => [row.dayKey, row]))
  const weekRows = new Map<string, { inMonth: CategoryCounts; outsideMonth: CategoryCounts }>()
  const monthRows = Array.from({ length: 12 }, emptyCategoryCounts)

  for (const row of rows) {
    const rowYear = Number(row.dayKey.slice(0, 4))
    if (rowYear === year) {
      const rowMonth = Number(row.dayKey.slice(5, 7)) - 1
      addGradeCount(monthRows[rowMonth], row)
    }
    const week = mondayKey(row.dayKey)
    if (week < firstWeekKey || week > lastWeekKey) continue
    let buckets = weekRows.get(week)
    if (!buckets) {
      buckets = { inMonth: emptyCategoryCounts(), outsideMonth: emptyCategoryCounts() }
      weekRows.set(week, buckets)
    }
    addGradeCount(
      row.dayKey >= monthStart && row.dayKey <= monthEnd ? buckets.inMonth : buckets.outsideMonth,
      row,
    )
  }

  const days: HistoricalCharts['days'] = []
  for (let d = 1; d <= lastOfMonth.getUTCDate(); d++) {
    const key = `${yearMonth}-${String(d).padStart(2, '0')}`
    const row = dailyRows.get(key)
    days.push({
      dayKey: key,
      inMonth: row
        ? { newChars: { ...row.newChars }, learnedChars: { ...row.learnedChars } }
        : emptyCategoryCounts(),
    })
  }

  const weeks: HistoricalCharts['weeks'] = []
  for (
    const start = new Date(firstWeek);
    start <= lastOfMonth;
    start.setUTCDate(start.getUTCDate() + 7)
  ) {
    const end = new Date(start)
    end.setUTCDate(end.getUTCDate() + 6)
    const startDay = dayKey(start)
    const endDay = dayKey(end)
    const buckets = weekRows.get(startDay)
    weeks.push({
      startDay,
      endDay,
      inMonth: buckets?.inMonth ?? emptyCategoryCounts(),
      outsideMonth: buckets?.outsideMonth ?? emptyCategoryCounts(),
    })
  }

  const months = monthRows.map((categories, index) => ({ month: index + 1, categories }))
  return { days, weeks, months }
}

/** 最多取五条已学字首轮事实，并排除初学日。 */
export function isCommonMistake(
  facts: Array<Pick<ReviewFact, 'dayKey' | 'grade' | 'isNew'>>,
): boolean {
  const recent = facts.filter(fact => !fact.isNew).slice(0, 5)
  return recent.filter(fact => fact.grade === 'c' || fact.grade === 'd').length >= 3
}

export function classifyCharacters(
  progress: Record<string, SM2State>,
  analytics: CharacterAnalytics[],
): CharacterClassification[] {
  const byCharacter = new Map(analytics.map(row => [row.character, row]))
  return Object.entries(progress).map(([character, sm2State]) => {
    const row = byCharacter.get(character)
    return {
      character,
      proficiency: getProficiency(sm2State),
      commonMistake: isCommonMistake(row?.recentLearnedFacts ?? []),
      forgottenAfterMastery:
        Boolean(row?.currentlyForgottenAfterMastery) && getProficiency(sm2State) !== 'mastered',
    }
  })
}

/** 模拟今天及之后六天的到期复习，并将未安排项结转。 */
export function simulateSevenDayForecast(
  progress: Record<string, SM2State>,
  dailyReviewLimit: number,
  today: string,
  completedOldRoundOneReviews: number,
): ForecastDay[] {
  const due = Object.entries(progress)
    .filter(([, state]) => state.nextReview <= addDays(today, 6))
    .map(([character, state]) => ({ character, state }))
    .sort(
      (a, b) => a.state.nextReview.localeCompare(b.state.nextReview) || b.state.ease - a.state.ease,
    )
  let pending = 0
  let cursor = 0
  const days: ForecastDay[] = []

  for (let offset = 0; offset < 7; offset++) {
    const date = addDays(today, offset)
    while (cursor < due.length && due[cursor].state.nextReview <= date) {
      pending++
      cursor++
    }
    const capacity = Math.max(
      0,
      dailyReviewLimit - (offset === 0 ? completedOldRoundOneReviews : 0),
    )
    const scheduledCount = Math.min(pending, capacity)
    const scheduled = due
      .slice(cursor - pending, cursor - pending + scheduledCount)
      .map(x => x.character)
    pending -= scheduledCount
    days.push({ dayKey: date, capacity, scheduled, remainingDue: pending })
  }
  return days
}
