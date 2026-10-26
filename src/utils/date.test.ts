import { describe, expect, it } from 'vitest'
import { formatDateLabel, formatReviewDueLabel } from './date'

describe('formatReviewDueLabel', () => {
  it('shows the number of days until a future review', () => {
    expect(formatReviewDueLabel('2026-06-08', '2026-06-05')).toBe('下次3天后')
  })

  it('marks reviews due today', () => {
    expect(formatReviewDueLabel('2026-06-05', '2026-06-05')).toBe('下次今天')
  })

  it('marks overdue reviews', () => {
    expect(formatReviewDueLabel('2026-06-02', '2026-06-05')).toBe('已逾期3天')
  })

  it('counts calendar days across month boundaries', () => {
    expect(formatReviewDueLabel('2026-07-01', '2026-06-29')).toBe('下次2天后')
  })

  it('rejects malformed and impossible dates', () => {
    expect(formatReviewDueLabel('NaN-NaN-NaN', '2026-06-05')).toBe('日期不可用')
    expect(formatReviewDueLabel('2026-02-30', '2026-06-05')).toBe('日期不可用')
    expect(formatDateLabel('NaN-NaN-NaN')).toBe('日期不可用')
  })
})
