/**
 * SM-2 Spaced Repetition Algorithm Implementation
 *
 * Based on the SuperMemo SM-2 algorithm by Piotr Woźniak.
 * Used to schedule character reviews based on the learner's performance.
 */

import type { Grade, SM2State } from './types'
import { GRADE_TO_Q, SM2_INITIAL_EASE, SM2_INITIAL_INTERVAL, SM2_MIN_EASE } from './types'

/**
 * Create initial SM-2 state for a new character.
 * Initial interval is 1 day (fixed).
 */
export function createInitialSM2State(): SM2State {
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + SM2_INITIAL_INTERVAL)
  return {
    ease: SM2_INITIAL_EASE,
    interval: SM2_INITIAL_INTERVAL,
    repetitions: 0,
    nextReview: toDateKey(tomorrow),
  }
}

/**
 * Update SM-2 state based on a review grade.
 *
 * For grade 'd' (complete forget):
 *   - ease resets to 2.5
 *   - interval resets to 1 day
 *   - repetitions reset to 0
 *
 * For grades a/b/c:
 *   - ease updated using SM-2 formula
 *   - new interval = round(current interval × new ease)
 *   - repetitions incremented
 *
 * @param current - Current SM-2 state (undefined for first review)
 * @param grade - Review grade (a, b, c, d)
 * @param reviewDate - ISO date string of the review
 * @returns Updated SM-2 state
 */
export function updateSM2(
  current: SM2State | undefined,
  grade: Grade,
  reviewDate: string,
): SM2State {
  // First review — create initial state
  if (!current) {
    current = createInitialSM2State()
  }

  // Grade d: complete forget — reset
  if (grade === 'd') {
    const nextDate = new Date(reviewDate + 'T00:00:00')
    nextDate.setDate(nextDate.getDate() + SM2_INITIAL_INTERVAL)
    return {
      ease: SM2_INITIAL_EASE,
      interval: SM2_INITIAL_INTERVAL,
      repetitions: 0,
      nextReview: toDateKey(nextDate),
    }
  }

  const q = GRADE_TO_Q[grade]

  // SM-2 ease factor update formula:
  // EF' = EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02))
  const easeDelta = 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)
  const newEase = Math.max(SM2_MIN_EASE, current.ease + easeDelta)

  // New interval = round(current interval × new ease)
  const newInterval = Math.round(current.interval * newEase)

  // Calculate next review date
  const nextDate = new Date(reviewDate + 'T00:00:00')
  nextDate.setDate(nextDate.getDate() + newInterval)

  return {
    ease: Math.round(newEase * 100) / 100, // round to 2 decimal places
    interval: newInterval,
    repetitions: current.repetitions + 1,
    nextReview: toDateKey(nextDate),
  }
}

/**
 * Check if a character is due for review on a given date.
 */
export function isDueForReview(state: SM2State, dateKey: string): boolean {
  return state.nextReview <= dateKey
}

/**
 * Convert a Date to "YYYY-MM-DD" format.
 */
export function toDateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Get today's date key.
 */
export function todayKey(): string {
  return toDateKey(new Date())
}
