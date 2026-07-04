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

// Import the function under test (we'll create it next)
// For now, define the expected behavior as tests
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
    // U+D800 is a high surrogate — must be followed by a low surrogate
    const corrupted = String.fromCharCode(0xD800)
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('lone low surrogate returns true', () => {
    // U+DC00 is a low surrogate — must be preceded by a high surrogate
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
    // U+0080–U+009F are C1 control codes — never appear in valid text
    expect(isUTF8Corrupted('')).toBe(true)
    expect(isUTF8Corrupted('')).toBe(true)
    expect(isUTF8Corrupted('')).toBe(true)
  })

  it('string with embedded C1 control char returns true', () => {
    // This simulates mojibake: 花 (UTF-8: E8 8A B1) → è±
    const mojibake = 'è±'
    expect(isUTF8Corrupted(mojibake)).toBe(true)
  })
})

// ============================================================
// getAllLogs — repair integration tests
// ============================================================

import db, { getAllLogs, appendLog } from './db'

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

describe('getAllLogs — UTF-8 repair', () => {
  beforeEach(async () => {
    // Clean the database before each test
    await db.logs.clear()
  })

  it('returns entries unchanged when no corruption is present', async () => {
    const entry = makeReviewEntry({ character: '花', timestamp: 1 })
    await appendLog(entry)

    const logs = await getAllLogs()
    expect(logs).toHaveLength(1)
    expect((logs[0] as any).character).toBe('花')
  })

  it('detects corruption from first character entry and removes all corrupted entries', async () => {
    // Insert a corrupted entry first (will trigger detection)
    // Use C1 control character to simulate mojibake
    const corrupted = makeReviewEntry({
      character: 'è±', // mojibake for 花
      timestamp: 1,
    })
    await appendLog(corrupted)

    // Insert another corrupted entry
    const corrupted2 = makeReviewEntry({
      character: 'å­', // mojibake for 字
      timestamp: 2,
    })
    await appendLog(corrupted2)

    // Insert a valid entry — should survive
    const valid = makeReviewEntry({ character: '山', timestamp: 3 })
    await appendLog(valid)

    // Insert an entry without a character field — should survive
    const nonCharEntry = {
      timestamp: 4,
      type: 'create_child',
      childId: 'child_1',
      name: '小明',
      wordBookId: 'wb_1',
    } as AnyLogEntry
    await appendLog(nonCharEntry)

    const logs = await getAllLogs()

    // Only valid entries survive
    expect(logs).toHaveLength(2)
    const characters = logs
      .filter((e: any) => e.character)
      .map((e: any) => e.character)
    expect(characters).toEqual(['山'])

    // Non-character entries survive
    const nonChars = logs.filter((e: any) => !('character' in e))
    expect(nonChars).toHaveLength(1)
  })

  it('does nothing when no entry has a character field', async () => {
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

    const logs = await getAllLogs()
    expect(logs).toHaveLength(2)
  })

  it('handles large number of entries without corruption', async () => {
    // Simulate a realistic scenario with many valid entries
    const entries: AnyLogEntry[] = []
    for (let i = 0; i < 50; i++) {
      entries.push(makeReviewEntry({ character: '花', timestamp: i + 1 }))
    }
    await db.logs.bulkAdd(entries)

    const logs = await getAllLogs()
    expect(logs).toHaveLength(50)
  })

  it('removes only corrupted entries, keeps clean ones in large mixed dataset', async () => {
    // Mix of corrupted and valid entries
    const corrupted = makeReviewEntry({
      character: '', // C1 control char — definitely corrupted
      timestamp: 1,
    })
    await appendLog(corrupted)

    const validEntries: AnyLogEntry[] = []
    for (let i = 0; i < 20; i++) {
      validEntries.push(makeReviewEntry({ character: '山', timestamp: i + 100 }))
    }
    await db.logs.bulkAdd(validEntries)

    const logs = await getAllLogs()
    expect(logs).toHaveLength(20)
  })

  it('only triggers repair when the FIRST entry with character is corrupted', async () => {
    // Valid entry comes first
    const validFirst = makeReviewEntry({ character: '花', timestamp: 1 })
    await appendLog(validFirst)

    // Corrupted entry comes later — should NOT trigger repair
    // (detection only checks the first entry with a character field)
    const corrupted = makeReviewEntry({
      character: '',
      timestamp: 2,
    })
    await appendLog(corrupted)

    const logs = await getAllLogs()
    // Both entries are returned because the first character entry is valid
    // (repair is not triggered)
    expect(logs).toHaveLength(2)
  })
})
