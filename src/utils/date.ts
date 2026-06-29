/**
 * Date utility helpers for 记汉字.
 */

import type { DayType } from './types'

/** Reference epoch for day type alternation — a known "learn" day */
const EPOCH_LEARN_DATE = '2026-01-01'

/**
 * Convert a date key "YYYY-MM-DD" to a Date object.
 */
export function parseDateKey(key: string): Date {
  return new Date(key + 'T00:00:00')
}

/**
 * Get the number of days between two date keys.
 */
export function daysBetween(a: string, b: string): number {
  const da = parseDateKey(a)
  const db = parseDateKey(b)
  return Math.round((db.getTime() - da.getTime()) / (1000 * 60 * 60 * 24))
}

/**
 * Determine if a given date is a "learn" day or "review" day.
 * Alternates: learn → review → learn → review → ...
 */
export function getDayType(dateKey: string): DayType {
  const diff = daysBetween(EPOCH_LEARN_DATE, dateKey)
  return diff % 2 === 0 ? 'learn' : 'review'
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
