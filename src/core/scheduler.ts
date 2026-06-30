/**
 * Daily Scheduler
 *
 * Determines today's task queue based on:
 * - Day type (learn vs review, alternating)
 * - Due reviews from SM-2 state
 * - New characters from the word book (learn days only)
 * - Daily quota limits
 */

import type { AppState, Child, TaskItem, DayType, ReviewEntry } from './types'
import { isDueForReview, todayKey } from './sm2'
import { getDayType } from '../utils/date'

/**
 * Generate today's task queue for a specific child.
 *
 * Review characters come first (sorted by due date, then by ease),
 * then new characters (on learn days only).
 */
export function generateTodayTasks(
  state: AppState,
  childId: string,
  dateKey: string,
): TaskItem[] {
  const child = state.children.find(c => c.id === childId)
  if (!child) return []

  const wordBook = state.wordBooks.find(w => w.id === child.wordBookId)
  if (!wordBook) return []

  const dayType = getDayType(dateKey)
  const { dailyReviewLimit, dailyNewChars } = state.settings

  // 1. Collect due review characters
  const dueReviews = getDueReviews(child, dateKey)

  // 2. Build review task items (limited by dailyReviewLimit)
  const reviewTasks: TaskItem[] = dueReviews
    .slice(0, dailyReviewLimit)
    .map(char => ({
      character: char,
      pinyin: '', // Will be populated from character metadata
      words: [],
      isNew: false,
      isReview: true,
      sm2State: child.progress[char],
    }))

  // 3. Add new characters on learn days (fill remaining quota)
  let newTasks: TaskItem[] = []
  if (dayType === 'learn') {
    const remainingQuota = Math.min(
      dailyNewChars,
      dailyReviewLimit + dailyNewChars - reviewTasks.length,
    )
    if (remainingQuota > 0) {
      newTasks = getNewCharacters(child, wordBook.characters, remainingQuota).map(char => ({
        character: char,
        pinyin: '',
        words: [],
        isNew: true,
        isReview: false,
        sm2State: undefined,
      }))
    }
  }

  return [...reviewTasks, ...newTasks]
}

/**
 * Get review characters that are due for today, sorted by priority.
 * Priority: due date (earliest first), then ease (higher = easier first).
 */
function getDueReviews(child: Child, dateKey: string): string[] {
  const due: { char: string; state: typeof child.progress[string] }[] = []

  for (const [char, state] of Object.entries(child.progress)) {
    if (isDueForReview(state, dateKey)) {
      due.push({ char, state })
    }
  }

  // Sort: earliest due date first, then higher ease first (easier items first)
  due.sort((a, b) => {
    if (a.state.nextReview !== b.state.nextReview) {
      return a.state.nextReview.localeCompare(b.state.nextReview)
    }
    return b.state.ease - a.state.ease
  })

  return due.map(d => d.char)
}

/**
 * Get new characters from the word book that the child hasn't learned yet,
 * in sequential order.
 */
function getNewCharacters(
  child: Child,
  allChars: string[],
  count: number,
): string[] {
  const result: string[] = []
  for (let i = child.nextCharIndex; i < allChars.length && result.length < count; i++) {
    const char = allChars[i]
    // Skip if already in progress (shouldn't happen if nextCharIndex is correct)
    if (!(char in child.progress)) {
      result.push(char)
    }
  }
  return result
}

/**
 * Get the characters that need re-review in subsequent rounds.
 * These are characters that received grade 'c' or 'd' in the current session.
 */
export function getNextRoundChars(
  sessionReviews: ReviewEntry[],
  currentRound: number,
): string[] {
  return sessionReviews
    .filter(r => r.round === currentRound && (r.grade === 'c' || r.grade === 'd'))
    .map(r => r.character)
}

/**
 * Count reviews for a specific day (for statistics).
 */
export function countReviewsForDay(
  reviews: ReviewEntry[],
  dateKey: string,
): { total: number; a: number; b: number; c: number; d: number } {
  const dayReviews = reviews.filter(r => r.dayKey === dateKey && r.round === 1)
  return {
    total: dayReviews.length,
    a: dayReviews.filter(r => r.grade === 'a').length,
    b: dayReviews.filter(r => r.grade === 'b').length,
    c: dayReviews.filter(r => r.grade === 'c').length,
    d: dayReviews.filter(r => r.grade === 'd').length,
  }
}

/**
 * Get the total daily limit (review + new) for a given day type.
 */
export function getDailyLimit(settings: { dailyReviewLimit: number; dailyNewChars: number }, dayType: DayType): number {
  if (dayType === 'learn') {
    return settings.dailyReviewLimit + settings.dailyNewChars
  }
  return settings.dailyReviewLimit
}

/**
 * Compute progress statistics for a child.
 */
export function getChildStats(child: Child) {
  const entries = Object.entries(child.progress)
  const total = entries.length

  if (total === 0) {
    return { total, a: 0, b: 0, c: 0, d: 0, aPercent: 0, bPercent: 0, cPercent: 0, dPercent: 0 }
  }

  // Count by last review grade stored in SM2State.lastGrade
  let a = 0, b = 0, c = 0, d = 0
  for (const [, state] of entries) {
    switch (state.lastGrade) {
      case 'a': a++; break
      case 'b': b++; break
      case 'c': c++; break
      case 'd': d++; break
    }
  }

  return {
    total,
    a, b, c, d,
    aPercent: Math.round((a / total) * 100),
    bPercent: Math.round((b / total) * 100),
    cPercent: Math.round((c / total) * 100),
    dPercent: Math.round((d / total) * 100),
  }
}
