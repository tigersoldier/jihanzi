/**
 * Date utility helpers for 记汉字.
 */

import type { DayType } from '../core/types'

/**
 * Convert a date key "YYYY-MM-DD" to a Date object.
 */
export function parseDateKey(key: string): Date {
  return new Date(key + 'T00:00:00')
}

/**
 * Get today's date key in "YYYY-MM-DD" format.
 */
export function todayKey(): string {
  return toDateKey(new Date())
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
 * Add days to a date key and return a new date key.
 */
export function addDays(dateKey: string, days: number): string {
  const d = parseDateKey(dateKey)
  d.setDate(d.getDate() + days)
  return toDateKey(d)
}

/**
 * Get a human-readable date label.
 */
export function formatDateLabel(dateKey: string): string {
  const d = parseDateKey(dateKey)
  const year = d.getFullYear()
  const month = d.getMonth() + 1
  const day = d.getDate()
  const weekDays = ['日', '一', '二', '三', '四', '五', '六']
  const weekDay = weekDays[d.getDay()]
  return `${year}年${month}月${day}日 星期${weekDay}`
}

/**
 * Get the day type label in Chinese.
 */
export function getDayTypeLabel(dayType: DayType): string {
  return dayType === 'learn' ? '学新日' : '纯复习日'
}

// ============================================================
// Interval Key — UTC date anchors: 1st, 11th, 21st of each month
// ============================================================

/** UTC date anchors for log/historical-snapshot interval boundaries */
const INTERVAL_DAYS = [1, 11, 21]

/**
 * Given a UTC timestamp (ms), return the interval key for the
 * 10/11-day period it falls into.
 *
 * The interval key is the UTC date anchor that starts the period,
 * formatted as "YYYY-MM-DD".
 *
 * Examples:
 *   2026-07-03T12:00:00Z → "2026-07-01"
 *   2026-07-11T00:00:00Z → "2026-07-11"
 *   2026-07-22T00:00:00Z → "2026-07-21"
 */
export function getIntervalKey(timestampMs: number): string {
  const d = new Date(timestampMs)
  // Get UTC day of month
  const utcDay = d.getUTCDate()

  // Find the anchor ≤ utcDay
  let anchor = 1
  for (const candidate of INTERVAL_DAYS) {
    if (candidate <= utcDay) anchor = candidate
  }

  // If the anchor is past the current month (e.g. Jan 2 wants anchor 1),
  // we use it directly. If the month has 28-31 days and we're past all
  // anchors, the last anchor (21) applies.
  // Build the UTC date string
  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(anchor).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Given two UTC timestamps, return the set of interval keys that
 * any log entries between them belong to (inclusive).
 *
 * @param fromMs — earliest timestamp (inclusive)
 * @param toMs   — latest timestamp (inclusive)
 */
export function getIntervalKeysBetween(fromMs: number, toMs: number): string[] {
  const keys = new Set<string>()
  // Walk day-by-day from fromMs to toMs, collecting interval keys.
  // For spans of a few days this is trivial; even for a 50-day gap
  // it's only ~50 iterations.
  const d = new Date(fromMs)
  // Align to start of UTC day
  d.setUTCHours(0, 0, 0, 0)
  const to = new Date(toMs)
  while (d.getTime() <= to.getTime()) {
    keys.add(getIntervalKey(d.getTime()))
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return Array.from(keys).sort()
}
