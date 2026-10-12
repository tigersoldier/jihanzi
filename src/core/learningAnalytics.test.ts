import { describe, expect, it } from 'vitest'
import {
  buildHistoricalCharts,
  classifyCharacters,
  isCommonMistake,
  simulateSevenDayForecast,
  type CharacterAnalytics,
  type DailyReviewStats,
} from './learningAnalytics'
import type { SM2State } from './types'

function stats(dayKey: string, overrides: Partial<DailyReviewStats> = {}): DailyReviewStats {
  return {
    childId: 'child_1',
    dayKey,
    newChars: { a: 0, b: 0, c: 0, d: 0 },
    learnedChars: { a: 0, b: 0, c: 0, d: 0 },
    ...overrides,
  }
}

function state(nextReview: string, ease = 2.5): SM2State {
  return {
    ease,
    interval: 1,
    repetitions: 2,
    nextReview,
    lastGrade: 'b',
    firstReviewDay: '2026-01-01',
  }
}

describe('buildHistoricalCharts', () => {
  it('keeps new/learned grade counts separated and fills zero days', () => {
    const charts = buildHistoricalCharts('2026-02', [
      stats('2026-02-01', {
        newChars: { a: 2, b: 0, c: 1, d: 0 },
        learnedChars: { a: 0, b: 1, c: 0, d: 1 },
      }),
    ])
    expect(charts.days).toHaveLength(28)
    expect(charts.days[0].inMonth.newChars).toEqual({ a: 2, b: 0, c: 1, d: 0 })
    expect(charts.days[1].inMonth).toEqual({
      newChars: { a: 0, b: 0, c: 0, d: 0 },
      learnedChars: { a: 0, b: 0, c: 0, d: 0 },
    })
    expect(charts.months[1].categories.learnedChars.d).toBe(1)
  })

  it('aggregates complete Monday-Sunday weeks and marks month-external counts', () => {
    const charts = buildHistoricalCharts('2026-08', [
      stats('2026-07-31', { learnedChars: { a: 1, b: 0, c: 0, d: 0 } }),
      stats('2026-08-01', { newChars: { a: 0, b: 1, c: 0, d: 0 } }),
      stats('2026-08-02', { learnedChars: { a: 0, b: 0, c: 1, d: 0 } }),
    ])
    expect(charts.weeks[0]).toMatchObject({
      startDay: '2026-07-27',
      endDay: '2026-08-02',
      inMonth: { newChars: { a: 0, b: 1, c: 0, d: 0 }, learnedChars: { a: 0, b: 0, c: 1, d: 0 } },
      outsideMonth: { learnedChars: { a: 1, b: 0, c: 0, d: 0 } },
    })
  })

  it('links annual month buckets to the selected month year', () => {
    const charts = buildHistoricalCharts('2025-12', [
      stats('2025-01-03', { newChars: { a: 1, b: 0, c: 0, d: 0 } }),
      stats('2026-01-03', { newChars: { a: 5, b: 0, c: 0, d: 0 } }),
    ])
    expect(charts.months[0].categories.newChars.a).toBe(1)
    expect(charts.months).toHaveLength(12)
  })
})

describe('common-mistake classification', () => {
  it('uses at most five learned-day round-one facts and excludes the introduction day', () => {
    const facts = [
      { dayKey: '2026-01-07', grade: 'c' as const, isNew: false },
      { dayKey: '2026-01-06', grade: 'd' as const, isNew: false },
      { dayKey: '2026-01-05', grade: 'c' as const, isNew: false },
      { dayKey: '2026-01-04', grade: 'a' as const, isNew: false },
      { dayKey: '2026-01-03', grade: 'd' as const, isNew: false },
      { dayKey: '2026-01-02', grade: 'd' as const, isNew: false },
      { dayKey: '2026-01-01', grade: 'd' as const, isNew: true },
    ]
    expect(isCommonMistake(facts)).toBe(true)
    expect(isCommonMistake(facts.slice(0, 2))).toBe(false)
    expect(isCommonMistake([facts[6], facts[0], facts[1], facts[3]])).toBe(false)
  })

  it('allows common-mistake to coexist with mastery and hides remastered forgotten status', () => {
    const analytics: CharacterAnalytics[] = [
      {
        childId: 'child_1',
        character: '花',
        recentLearnedFacts: [
          { dayKey: '2026-01-04', timestamp: 4, grade: 'c', isNew: false },
          { dayKey: '2026-01-03', timestamp: 3, grade: 'd', isNew: false },
          { dayKey: '2026-01-02', timestamp: 2, grade: 'c', isNew: false },
        ],
        everForgottenAfterMastery: true,
        currentlyForgottenAfterMastery: true,
      },
    ]
    const classified = classifyCharacters(
      {
        花: { ...state('2026-01-09', 2.5), repetitions: 3, lastGrade: 'a' },
      },
      analytics,
    )
    expect(classified[0]).toMatchObject({
      proficiency: 'mastered',
      commonMistake: true,
      forgottenAfterMastery: false,
    })
  })
})

describe('simulateSevenDayForecast', () => {
  it('deducts completed old-character reviews today, carries backlog, and respects capacity', () => {
    const forecast = simulateSevenDayForecast(
      {
        甲: state('2026-03-01'),
        乙: state('2026-03-01', 2.6),
        丙: state('2026-03-02'),
        丁: state('2026-03-08'),
        戊: state('2026-03-09'),
      },
      2,
      '2026-03-01',
      1,
    )
    expect(forecast[0]).toMatchObject({ capacity: 1, scheduled: ['乙'], remainingDue: 1 })
    expect(forecast[1]).toMatchObject({ scheduled: ['甲', '丙'], remainingDue: 0 })
    expect(forecast[6]).toMatchObject({ dayKey: '2026-03-07', scheduled: [], remainingDue: 0 })
  })

  it('does not assign reviews beyond the seven-day window', () => {
    const forecast = simulateSevenDayForecast({ 甲: state('2026-03-08') }, 10, '2026-03-01', 0)
    expect(forecast).toHaveLength(7)
    expect(forecast.reduce((sum, day) => sum + day.scheduled.length, 0)).toBe(0)
  })
})
