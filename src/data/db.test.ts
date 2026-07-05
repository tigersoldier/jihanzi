/**
 * @vitest-environment node
 *
 * Tests for IndexedDB operations including UTF-8 corruption detection and repair.
 * Uses fake-indexeddb to simulate IndexedDB in Node.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { AnyLogEntry } from '../core/types'

// ============================================================
// isUTF8Corrupted — pure function tests
// ============================================================

import { isUTF8Corrupted } from './db'

describe('isUTF8Corrupted', () => {
  // ---- Valid strings ----

  it('valid Chinese character returns false', () => {
    expect(isUTF8Corrupted('花')).toBe(false)
    expect(isUTF8Corrupted('汉')).toBe(false)
    expect(isUTF8Corrupted('字')).toBe(false)
  })

  it('valid multi-character Chinese string returns false', () => {
    expect(isUTF8Corrupted('汉字')).toBe(false)
    expect(isUTF8Corrupted('你好世界')).toBe(false)
  })

  it('ASCII string returns false', () => {
    expect(isUTF8Corrupted('hello')).toBe(false)
    expect(isUTF8Corrupted('abc123')).toBe(false)
  })

  it('emoji (surrogate pair) returns false', () => {
    expect(isUTF8Corrupted('😀')).toBe(false)
    expect(isUTF8Corrupted('🎉')).toBe(false)
  })

  it('empty string returns false', () => {
    expect(isUTF8Corrupted('')).toBe(false)
  })

  it('mixed valid content returns false', () => {
    expect(isUTF8Corrupted('hello世界😀')).toBe(false)
  })

  // ---- Invalid: lone surrogates ----

  it('lone high surrogate returns true', () => {
    const corrupted = String.fromCharCode(0xD800)
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('lone low surrogate returns true', () => {
    const corrupted = String.fromCharCode(0xDC00)
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('high surrogate followed by non-surrogate returns true', () => {
    const corrupted = String.fromCharCode(0xD800) + 'a'
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('string with embedded lone surrogate returns true', () => {
    const corrupted = 'ab' + String.fromCharCode(0xD800) + 'cd'
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  // ---- Invalid: C1 control characters (mojibake from UTF-8 → Latin-1) ----

  it('C1 control character returns true', () => {
    expect(isUTF8Corrupted('\x80')).toBe(true)
    expect(isUTF8Corrupted('\x8F')).toBe(true)
    expect(isUTF8Corrupted('\x9F')).toBe(true)
  })

  it('string with embedded C1 control char returns true', () => {
    const mojibake = 'è±'
    expect(isUTF8Corrupted(mojibake)).toBe(true)
  })
})

// ============================================================
// repairCorruptedLogs — migration repair tests
// ============================================================

import db, { appendLog, repairCorruptedLogs } from './db'

function makeReviewEntry(overrides: Partial<AnyLogEntry> = {}): AnyLogEntry {
  return {
    timestamp: Date.now(),
    type: 'review',
    childId: 'child_test',
    character: '花',
    grade: 'a',
    round: 1,
    dayKey: '2026-07-04',
    ...overrides,
  } as AnyLogEntry
}

describe('repairCorruptedLogs', () => {
  beforeEach(async () => {
    await db.logs.clear()
  })

  it('returns 0 when no corruption is present', async () => {
    const entry = makeReviewEntry({ character: '花', timestamp: 1 })
    await appendLog(entry)

    const deleted = await repairCorruptedLogs()
    expect(deleted).toBe(0)

    const count = await db.logs.count()
    expect(count).toBe(1)
  })

  it('deletes corrupted entries and stops at first clean entry', async () => {
    // Put corrupted entries first (oldest)
    const corrupted1 = makeReviewEntry({ character: '\x80', timestamp: 1 })
    const corrupted2 = makeReviewEntry({ character: '\x90', timestamp: 2 })
    await db.logs.bulkAdd([corrupted1, corrupted2])

    // Then a clean entry — repair should stop here
    const clean = makeReviewEntry({ character: '山', timestamp: 3 })
    await appendLog(clean)

    // Then more entries (not touched by repair)
    const later = makeReviewEntry({ character: '水', timestamp: 4 })
    await appendLog(later)

    const deleted = await repairCorruptedLogs()
    expect(deleted).toBe(2)

    // Clean entries survive
    const count = await db.logs.count()
    expect(count).toBe(2)
  })

  it('stops at first clean character entry, skips non-character entries', async () => {
    // Non-character entry is not used for corruption detection
    const nonChar = {
      timestamp: 1,
      type: 'create_child',
      childId: 'child_1',
      name: '小明',
      wordBookId: 'wb_1',
    } as AnyLogEntry
    await appendLog(nonChar)

    // Corrupted entry after non-char entry
    const corrupted = makeReviewEntry({ character: '\x80', timestamp: 2 })
    await appendLog(corrupted)

    // Clean entry — should stop iteration
    const clean = makeReviewEntry({ character: '花', timestamp: 3 })
    await appendLog(clean)

    const deleted = await repairCorruptedLogs()
    expect(deleted).toBe(1)
  })

  it('handles no character entries at all', async () => {
    const entry1 = {
      timestamp: 1,
      type: 'create_child',
      childId: 'child_1',
      name: '小明',
      wordBookId: 'wb_1',
    } as AnyLogEntry
    const entry2 = {
      timestamp: 2,
      type: 'create_wordbook',
      wordBookId: 'wb_1',
      name: '生字本',
      characters: ['花'],
    } as AnyLogEntry

    await db.logs.bulkAdd([entry1, entry2])

    const deleted = await repairCorruptedLogs()
    expect(deleted).toBe(0)
    expect(await db.logs.count()).toBe(2)
  })
})
