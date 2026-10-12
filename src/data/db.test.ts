/**
 * @vitest-environment node
 *
 * Tests for IndexedDB operations including UTF-8 corruption detection and repair.
 * Uses fake-indexeddb to simulate IndexedDB in Node.
 */

import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach } from 'vitest'
import type { AnyLogEntry } from '../core/types'
import { buildHistoricalCharts } from '../core/learningAnalytics'

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
    const corrupted = String.fromCharCode(0xd800)
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('lone low surrogate returns true', () => {
    const corrupted = String.fromCharCode(0xdc00)
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('high surrogate followed by non-surrogate returns true', () => {
    const corrupted = String.fromCharCode(0xd800) + 'a'
    expect(isUTF8Corrupted(corrupted)).toBe(true)
  })

  it('string with embedded lone surrogate returns true', () => {
    const corrupted = 'ab' + String.fromCharCode(0xd800) + 'cd'
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

import db, {
  appendLog,
  repairCorruptedLogs,
  getReviewsForChild,
  getReviewsForChildChar,
  getReviewsForChildCharPaginated,
  dedupeLocalLogs,
  appendLogs,
  backfillLearningAnalytics,
  getDailyReviewStatsInRange,
  getCharacterAnalyticsForChild,
  recordAppliedReviewAnalytics,
  reconstructReviewAnalyticsUpdates,
} from './db'

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

// ============================================================
// v2→v3 snapshot migration
// ============================================================

import Dexie from 'dexie'

describe('v2→v3 snapshot migration', () => {
  it('stamps type=current on existing v2 snapshot rows after upgrade', async () => {
    // Simulate a v2 database with a snapshot row that has no 'type' field.
    // We open a fresh v2 DB outside the app's regular schema to avoid
    // interfering with the main db instance.
    const v2db = new Dexie('jihanzi_v2_migration_test')
    v2db.version(2).stores({
      logs: '++id, timestamp',
      snapshot: '++id, timestamp',
      meta: 'key',
    })

    const snapshotState = {
      children: [
        { id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} },
      ],
      wordBooks: [{ id: 'wb_1', name: '测试', characters: ['花'] }],
      settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    }

    // Insert a snapshot row WITHOUT the 'type' field (v2 format)
    await v2db.table('snapshot').add({
      timestamp: 1000,
      state: snapshotState,
    })
    expect(await v2db.table('snapshot').count()).toBe(1)
    v2db.close()

    // Now open at v3 with the upgrade — this simulates the real migration
    const v3db = new Dexie('jihanzi_v2_migration_test')
    v3db.version(2).stores({
      logs: '++id, timestamp',
      snapshot: '++id, timestamp',
      meta: 'key',
    })
    v3db
      .version(3)
      .stores({
        logs: '++id, timestamp',
        snapshot: '++id, timestamp, type',
        meta: 'key',
      })
      .upgrade(async tx => {
        // The upgrade callback: stamp existing rows
        const snapshots = tx.table('snapshot')
        await snapshots.toCollection().modify(row => {
          row.type = 'current'
        })
      })

    await v3db.open()

    // Query using the 'type' index — should find the row now
    const rows = await v3db.table('snapshot').where('type').equals('current').toArray()
    expect(rows).toHaveLength(1)
    expect(rows[0].timestamp).toBe(1000)
    expect(rows[0].state.children[0].name).toBe('小明')
    v3db.close()

    // Clean up the test database
    await Dexie.delete('jihanzi_v2_migration_test')
  })
})

// ============================================================
// getReviewsForChild / getReviewsForChildChar
// ============================================================

describe('getReviewsForChild', () => {
  beforeEach(async () => {
    await db.logs.clear()
  })

  it('returns review entries for a specific child', async () => {
    const r1 = makeReviewEntry({ childId: 'child_a', character: '花', timestamp: 1, grade: 'a' })
    const r2 = makeReviewEntry({ childId: 'child_a', character: '山', timestamp: 2, grade: 'b' })
    const r3 = makeReviewEntry({ childId: 'child_b', character: '水', timestamp: 3, grade: 'c' })
    await db.logs.bulkAdd([r1, r2, r3])

    const result = await getReviewsForChild('child_a')
    expect(result).toHaveLength(2)
    expect(result.map(r => r.character).sort()).toEqual(['山', '花'])
  })

  it('returns empty array when no reviews exist for child', async () => {
    const r1 = makeReviewEntry({ childId: 'child_b', character: '水', timestamp: 1 })
    await db.logs.bulkAdd([r1])

    const result = await getReviewsForChild('child_a')
    expect(result).toHaveLength(0)
  })
})

describe('getReviewsForChildChar', () => {
  beforeEach(async () => {
    await db.logs.clear()
  })

  it('returns review entries for a specific child and character', async () => {
    const r1 = makeReviewEntry({
      childId: 'child_a',
      character: '花',
      timestamp: 1,
      grade: 'a',
      dayKey: '2026-07-01',
    })
    const r2 = makeReviewEntry({
      childId: 'child_a',
      character: '花',
      timestamp: 2,
      grade: 'b',
      dayKey: '2026-07-02',
    })
    const r3 = makeReviewEntry({
      childId: 'child_a',
      character: '山',
      timestamp: 3,
      grade: 'c',
      dayKey: '2026-07-01',
    })
    await db.logs.bulkAdd([r1, r2, r3])

    const result = await getReviewsForChildChar('child_a', '花')
    expect(result).toHaveLength(2)
    expect(result[0].grade).toBe('a')
    expect(result[1].grade).toBe('b')
  })

  it('returns empty array when character has no reviews', async () => {
    const r1 = makeReviewEntry({ childId: 'child_a', character: '花', timestamp: 1 })
    await db.logs.bulkAdd([r1])

    const result = await getReviewsForChildChar('child_a', '水')
    expect(result).toHaveLength(0)
  })

  it('filters out non-review entries with same child and character', async () => {
    const reviewEntry = makeReviewEntry({
      childId: 'child_a',
      character: '花',
      timestamp: 1,
      grade: 'a',
    })
    // 非 review 条目不应被返回
    const nonReview = {
      timestamp: 2,
      type: 'create_child',
      childId: 'child_a',
      name: '小明',
      wordBookId: 'wb_1',
    } as AnyLogEntry
    await db.logs.bulkAdd([reviewEntry, nonReview])

    const result = await getReviewsForChildChar('child_a', '花')
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('review')
  })
})

// ============================================================
// getReviewsForChildCharPaginated — cursor-based 分页
// ============================================================

describe('getReviewsForChildCharPaginated', () => {
  beforeEach(async () => {
    await db.logs.clear()
  })

  it('returns first page and hasMore flag', async () => {
    // 创建 55 条复习记录，分页大小 51（显示 50）
    const entries: AnyLogEntry[] = []
    for (let i = 0; i < 55; i++) {
      entries.push(
        makeReviewEntry({
          childId: 'child_a',
          character: '花',
          timestamp: i + 1,
          grade: 'a',
          dayKey: `2026-07-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`,
        }),
      )
    }
    await db.logs.bulkAdd(entries)

    const page1 = await getReviewsForChildCharPaginated('child_a', '花', 51)
    // 返回 50 条（limit - 1），有更多
    expect(page1.entries).toHaveLength(50)
    expect(page1.hasMore).toBe(true)
    expect(page1.cursor).toBeGreaterThan(0)
  })

  it('returns hasMore=false when total < limit', async () => {
    const entries: AnyLogEntry[] = []
    for (let i = 0; i < 10; i++) {
      entries.push(
        makeReviewEntry({
          childId: 'child_a',
          character: '花',
          timestamp: i + 1,
          grade: 'a',
          dayKey: `2026-07-0${i + 1}`,
        }),
      )
    }
    await db.logs.bulkAdd(entries)

    const page = await getReviewsForChildCharPaginated('child_a', '花', 51)
    expect(page.entries).toHaveLength(10)
    expect(page.hasMore).toBe(false)
    expect(page.cursor).toBeGreaterThan(0) // 有 entry 就有 cursor
  })

  it('uses cursor to fetch next page', async () => {
    const entries: AnyLogEntry[] = []
    for (let i = 0; i < 105; i++) {
      entries.push(
        makeReviewEntry({
          childId: 'child_a',
          character: '花',
          timestamp: i + 1,
          grade: 'a',
          dayKey: `2026-07-${String(Math.floor(i / 5) + 1).padStart(2, '0')}`,
        }),
      )
    }
    await db.logs.bulkAdd(entries)

    // 第一页
    const page1 = await getReviewsForChildCharPaginated('child_a', '花', 51)
    expect(page1.entries).toHaveLength(50)
    expect(page1.hasMore).toBe(true)

    // 第二页 — 使用 page1.cursor
    const page2 = await getReviewsForChildCharPaginated('child_a', '花', 51, page1.cursor!)
    expect(page2.entries).toHaveLength(50)
    expect(page2.hasMore).toBe(true)

    // 第三页（最后，只有 5 条剩余）
    const page3 = await getReviewsForChildCharPaginated('child_a', '花', 51, page2.cursor!)
    expect(page3.entries).toHaveLength(5)
    expect(page3.hasMore).toBe(false)
    // cursor 仍然指向最后一条 entry 的 id，不用时为 null

    // 验证不重叠：三页的 entry id 应互不重复
    const ids = new Set([
      ...page1.entries.map(e => (e as any).id),
      ...page2.entries.map(e => (e as any).id),
      ...page3.entries.map(e => (e as any).id),
    ])
    expect(ids.size).toBe(105)
  })

  it('returns empty when cursor has no more entries', async () => {
    const entries: AnyLogEntry[] = []
    for (let i = 0; i < 5; i++) {
      entries.push(
        makeReviewEntry({
          childId: 'child_a',
          character: '花',
          timestamp: i + 1,
          grade: 'a',
          dayKey: '2026-07-01',
        }),
      )
    }
    await db.logs.bulkAdd(entries)

    const page = await getReviewsForChildCharPaginated('child_a', '花', 51)
    // reverse 排序下 cursor 是当前页最小的 id，传入 cursor 即 id < cursor 无更多记录
    const next = await getReviewsForChildCharPaginated('child_a', '花', 51, page.cursor!)
    expect(next.entries).toHaveLength(0)
    expect(next.hasMore).toBe(false)
    expect(next.cursor).toBeNull()
  })
})

describe('learning analytics projection', () => {
  beforeEach(async () => {
    await db.logs.clear()
    await db.snapshot.clear()
    await db.meta.clear()
    await db.reviewFacts.clear()
    await db.dailyReviewStats.clear()
    await db.characterAnalytics.clear()
  })

  it('classifies retained learned-character reviews from the snapshot when earlier logs were pruned', async () => {
    await db.snapshot.put({
      type: 'current',
      timestamp: 30,
      state: {
        children: [
          {
            id: 'child_test',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              花: {
                ease: 2.5,
                interval: 2,
                repetitions: 2,
                nextReview: '2026-07-02',
                lastGrade: 'a',
                firstReviewDay: '2026-06-30',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '测试', characters: ['花'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    })
    await db.logs.bulkAdd([makeReviewEntry({ timestamp: 30, grade: 'b', dayKey: '2026-07-02' })])

    await backfillLearningAnalytics()

    const [day] = await getDailyReviewStatsInRange('child_test', '2026-07-02', '2026-07-02')
    const charts = buildHistoricalCharts('2026-07', [day])
    expect(charts.days[1].inMonth.learnedChars.b).toBe(1)
    expect(charts.days[1].inMonth.newChars.b).toBe(0)
  })

  it('rebuilds a completed old projection instead of keeping its incorrect category', async () => {
    await db.snapshot.put({
      type: 'current',
      timestamp: 30,
      state: {
        children: [
          {
            id: 'child_test',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              花: {
                ease: 2.5,
                interval: 2,
                repetitions: 2,
                nextReview: '2026-07-02',
                lastGrade: 'a',
                firstReviewDay: '2026-06-30',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '测试', characters: ['花'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    })
    await db.logs.bulkAdd([makeReviewEntry({ timestamp: 30, grade: 'b', dayKey: '2026-07-02' })])
    await db.reviewFacts.add({
      childId: 'child_test',
      character: '花',
      dayKey: '2026-07-02',
      timestamp: 30,
      grade: 'b',
      isNew: true,
    })
    await db.dailyReviewStats.add({
      childId: 'child_test',
      dayKey: '2026-07-02',
      newChars: { a: 0, b: 1, c: 0, d: 0 },
      learnedChars: { a: 0, b: 0, c: 0, d: 0 },
    })
    await db.characterAnalytics.add({
      childId: 'child_test',
      character: '花',
      recentLearnedFacts: [{ dayKey: '2026-07-02', timestamp: 30, grade: 'b', isNew: true }],
      everForgottenAfterMastery: true,
      currentlyForgottenAfterMastery: true,
      lastMasteryStatusTimestamp: 25,
    })
    await db.meta.put({
      key: 'learningAnalyticsBackfill',
      value: { ready: true, processed: 1, total: 1 },
    })

    await backfillLearningAnalytics()

    const [day] = await getDailyReviewStatsInRange('child_test', '2026-07-02', '2026-07-02')
    expect(day.learnedChars.b).toBe(1)
    expect(day.newChars.b).toBe(0)
    expect((await getCharacterAnalyticsForChild('child_test'))[0]).toMatchObject({
      recentLearnedFacts: [{ dayKey: '2026-07-02', timestamp: 30, grade: 'b', isNew: false }],
      everForgottenAfterMastery: true,
      currentlyForgottenAfterMastery: true,
      lastMasteryStatusTimestamp: 25,
    })
  })

  it('reclassifies existing facts from the snapshot when their source logs were pruned', async () => {
    await db.snapshot.put({
      type: 'current',
      timestamp: 30,
      state: {
        children: [
          {
            id: 'child_test',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              花: {
                ease: 2.5,
                interval: 2,
                repetitions: 2,
                nextReview: '2026-07-02',
                lastGrade: 'a',
                firstReviewDay: '2026-06-30',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '测试', characters: ['花'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    })
    await db.reviewFacts.add({
      childId: 'child_test',
      character: '花',
      dayKey: '2026-07-02',
      timestamp: 30,
      grade: 'b',
      isNew: true,
    })
    await db.dailyReviewStats.add({
      childId: 'child_test',
      dayKey: '2026-07-02',
      newChars: { a: 0, b: 1, c: 0, d: 0 },
      learnedChars: { a: 0, b: 0, c: 0, d: 0 },
    })
    await db.meta.put({
      key: 'learningAnalyticsBackfill',
      value: { ready: true, processed: 1, total: 1 },
    })

    await backfillLearningAnalytics()

    const [day] = await getDailyReviewStatsInRange('child_test', '2026-07-02', '2026-07-02')
    expect(day.learnedChars.b).toBe(1)
    expect(day.newChars.b).toBe(0)
  })

  it('resumes existing-fact reclassification across batches', async () => {
    const characters = Array.from({ length: 501 }, (_, index) => `字${index}`)
    await db.snapshot.put({
      type: 'current',
      timestamp: 30,
      state: {
        children: [
          {
            id: 'child_test',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: characters.length,
            progress: Object.fromEntries(
              characters.map(character => [
                character,
                {
                  ease: 2.5,
                  interval: 2,
                  repetitions: 2,
                  nextReview: '2026-07-02',
                  lastGrade: 'a',
                  firstReviewDay: '2026-06-30',
                },
              ]),
            ),
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '测试', characters }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    })
    await db.reviewFacts.bulkAdd(
      characters.map((character, index) => ({
        childId: 'child_test',
        character,
        dayKey: '2026-07-02',
        timestamp: index + 1,
        grade: 'a' as const,
        isNew: true,
      })),
    )
    await db.dailyReviewStats.add({
      childId: 'child_test',
      dayKey: '2026-07-02',
      newChars: { a: characters.length, b: 0, c: 0, d: 0 },
      learnedChars: { a: 0, b: 0, c: 0, d: 0 },
    })
    await db.meta.put({
      key: 'learningAnalyticsBackfill',
      value: { ready: true, processed: characters.length, total: characters.length },
    })

    const progress: string[] = []
    await backfillLearningAnalytics(status => {
      progress.push(`${status.phase}:${status.processed}/${status.total}`)
    })

    const [day] = await getDailyReviewStatsInRange('child_test', '2026-07-02', '2026-07-02')
    expect(day.newChars.a).toBe(0)
    expect(day.learnedChars.a).toBe(characters.length)
    expect(progress).toContain('facts:500/501')
  })

  it('projects batch-imported review facts with learned-character categories', async () => {
    await appendLogs(
      [makeReviewEntry({ timestamp: 5, grade: 'b', dayKey: '2026-07-01' })],
      [{ isNew: false }],
    )
    const [day] = await getDailyReviewStatsInRange('child_test', '2026-07-01', '2026-07-01')
    expect(day.learnedChars.b).toBe(1)
  })

  it('keeps the earliest same-day round-one fact and corrects its daily count idempotently', async () => {
    const later = makeReviewEntry({ timestamp: 200, grade: 'a', dayKey: '2026-07-01' })
    const earlier = makeReviewEntry({ timestamp: 100, grade: 'd', dayKey: '2026-07-01' })
    await appendLog(later, { isNew: true })
    await appendLog(earlier, { isNew: true })
    await appendLog({ ...earlier, timestamp: 300 }, { isNew: true })
    await appendLog(makeReviewEntry({ timestamp: 400, round: 2, dayKey: '2026-07-01' }))

    const facts = await db.reviewFacts.toArray()
    expect(facts).toHaveLength(1)
    expect(facts[0]).toMatchObject({ timestamp: 100, grade: 'd', isNew: true })
    const [day] = await getDailyReviewStatsInRange('child_test', '2026-07-01', '2026-07-01')
    expect(day.newChars).toEqual({ a: 0, b: 0, c: 0, d: 1 })
    expect(day.learnedChars).toEqual({ a: 0, b: 0, c: 0, d: 0 })
  })

  it('only marks accepted d relapse transitions and preserves history after re-mastery', async () => {
    for (const grade of ['b', 'c'] as const) {
      await appendLog(makeReviewEntry({ timestamp: grade === 'b' ? 10 : 15, grade }), {
        isNew: false,
        accepted: true,
        wasMastered: true,
        isMastered: false,
      })
    }
    expect((await getCharacterAnalyticsForChild('child_test'))[0]?.everForgottenAfterMastery).toBe(
      false,
    )

    const unapplied = makeReviewEntry({ timestamp: 18, grade: 'd' })
    await appendLog(unapplied, {
      isNew: false,
      accepted: false,
      wasMastered: true,
      isMastered: false,
    })
    expect((await getCharacterAnalyticsForChild('child_test'))[0]?.everForgottenAfterMastery).toBe(
      false,
    )

    const relapse = makeReviewEntry({ timestamp: 20, grade: 'd', dayKey: '2026-07-05' })
    await appendLog(relapse, {
      isNew: false,
      accepted: true,
      wasMastered: true,
      isMastered: false,
    })
    let analytics = (await getCharacterAnalyticsForChild('child_test'))[0]
    expect(analytics).toMatchObject({
      everForgottenAfterMastery: true,
      currentlyForgottenAfterMastery: true,
    })

    await recordAppliedReviewAnalytics(
      makeReviewEntry({ timestamp: 30, grade: 'a', dayKey: '2026-07-06' }) as Extract<
        AnyLogEntry,
        { type: 'review' }
      >,
      false,
      true,
    )
    analytics = (await getCharacterAnalyticsForChild('child_test'))[0]
    expect(analytics).toMatchObject({
      everForgottenAfterMastery: true,
      currentlyForgottenAfterMastery: false,
    })
    await appendLog(makeReviewEntry({ timestamp: 25, grade: 'd', dayKey: '2026-07-05' }), {
      isNew: false,
      accepted: true,
      wasMastered: true,
      isMastered: false,
    })
    analytics = (await getCharacterAnalyticsForChild('child_test'))[0]
    expect(analytics).toMatchObject({
      everForgottenAfterMastery: true,
      currentlyForgottenAfterMastery: false,
    })
  })

  it('removes replay state from an already completed backfill checkpoint', async () => {
    await db.meta.put({
      key: 'learningAnalyticsBackfill',
      value: {
        version: 3,
        phase: 'logs',
        ready: true,
        processed: 500,
        total: 500,
        replayState: { children: [], wordBooks: [], settings: {} },
      },
    })

    await backfillLearningAnalytics()

    expect(await db.meta.get('learningAnalyticsBackfill')).toMatchObject({
      value: { ready: true, processed: 500, total: 500 },
    })
    expect((await db.meta.get('learningAnalyticsBackfill'))?.value).not.toHaveProperty(
      'replayState',
    )
  })

  it('reconstructs watermark-covered outcomes from only the character review history', async () => {
    const history = [
      makeReviewEntry({ timestamp: 10, dayKey: '2026-07-01', grade: 'a' }),
      makeReviewEntry({ timestamp: 20, dayKey: '2026-07-04', grade: 'a' }),
      makeReviewEntry({ timestamp: 30, dayKey: '2026-07-12', grade: 'a' }),
    ]
    const coveredRelapse = makeReviewEntry({
      timestamp: 40,
      dayKey: '2026-08-03',
      grade: 'd',
    })
    await db.logs.bulkAdd(history)

    const outcomes = await reconstructReviewAnalyticsUpdates([coveredRelapse], 50)
    expect(outcomes.get('40:review:child_test:花')).toMatchObject({
      accepted: true,
      wasMastered: true,
      isMastered: false,
    })
  })

  it('derives new-versus-learned metadata for all incoming reviews without a snapshot watermark', async () => {
    const incoming = [
      makeReviewEntry({ timestamp: 10, dayKey: '2026-07-01', grade: 'a' }),
      makeReviewEntry({ timestamp: 20, dayKey: '2026-07-04', grade: 'c' }),
    ]

    const updates = await reconstructReviewAnalyticsUpdates(incoming)

    expect(updates.get('10:review:child_test:花')).toMatchObject({
      isNew: true,
      accepted: true,
      wasMastered: false,
      isMastered: false,
    })
    expect(updates.get('20:review:child_test:花')).toMatchObject({
      isNew: false,
      accepted: true,
      wasMastered: false,
      isMastered: false,
    })
  })

  it('recomputes only the latest five learned facts after a late same-day correction', async () => {
    await appendLog(makeReviewEntry({ timestamp: 10, dayKey: '2026-07-01', grade: 'd' }), {
      isNew: true,
    })
    for (let day = 2; day <= 8; day++) {
      await appendLog(
        makeReviewEntry({
          timestamp: day * 10,
          dayKey: `2026-07-${String(day).padStart(2, '0')}`,
          grade: day % 2 === 0 ? 'c' : 'a',
        }),
        { isNew: false },
      )
    }
    await appendLog(makeReviewEntry({ timestamp: 69, dayKey: '2026-07-06', grade: 'd' }), {
      isNew: false,
    })

    const analytics = (await getCharacterAnalyticsForChild('child_test'))[0]
    expect(analytics.recentLearnedFacts.map(fact => fact.dayKey)).toEqual([
      '2026-07-08',
      '2026-07-07',
      '2026-07-06',
      '2026-07-05',
      '2026-07-04',
    ])
    expect(analytics.recentLearnedFacts).toHaveLength(5)
    expect(analytics.recentLearnedFacts.some(fact => fact.isNew)).toBe(false)
  })

  it('backfills existing logs once and is idempotent', async () => {
    await db.logs.bulkAdd([
      {
        timestamp: 1,
        type: 'create_wordbook',
        wordBookId: 'wb_1',
        name: '测试',
        characters: ['花'],
      },
      {
        timestamp: 2,
        type: 'create_child',
        childId: 'child_test',
        name: '小明',
        wordBookId: 'wb_1',
      },
      makeReviewEntry({ timestamp: 10, grade: 'a', dayKey: '2026-07-01' }),
      makeReviewEntry({ timestamp: 11, grade: 'd', round: 2, dayKey: '2026-07-01' }),
      makeReviewEntry({ timestamp: 20, grade: 'c', dayKey: '2026-07-02' }),
    ] as AnyLogEntry[])

    await backfillLearningAnalytics()
    await backfillLearningAnalytics()

    expect(await db.reviewFacts.count()).toBe(2)
    const rows = await getDailyReviewStatsInRange('child_test', '2026-07-01', '2026-07-02')
    expect(rows).toHaveLength(2)
    expect(rows.find(row => row.dayKey === '2026-07-01')?.newChars.a).toBe(1)
    expect(rows.find(row => row.dayKey === '2026-07-02')?.learnedChars.c).toBe(1)
    const checkpoint = await db.meta.get('learningAnalyticsBackfill')
    expect(checkpoint?.value).not.toHaveProperty('replayState')
  })
})

describe('dedupeLocalLogs', () => {
  beforeEach(async () => {
    await db.logs.clear()
  })

  it('删除重复条目，保留每个去重键的首次记录', async () => {
    const r1 = makeReviewEntry({ childId: 'child_a', character: '花', timestamp: 1, grade: 'a' })
    const r2 = makeReviewEntry({ childId: 'child_a', character: '花', timestamp: 1, grade: 'b' }) // 同 key 重复
    const r3 = makeReviewEntry({ childId: 'child_a', character: '山', timestamp: 2, grade: 'b' })
    await db.logs.bulkAdd([r1, r2, r3])

    const deleted = await dedupeLocalLogs()

    expect(deleted).toBe(1)
    const remaining = await db.logs.toArray()
    expect(remaining).toHaveLength(2)
    // 保留首次记录（id 最小），即 grade 'a'
    const kept = remaining.find(r => r.character === '花')
    expect(kept?.grade).toBe('a')
  })

  it('无重复时删除 0 条', async () => {
    const r1 = makeReviewEntry({ childId: 'child_a', character: '花', timestamp: 1 })
    const r2 = makeReviewEntry({ childId: 'child_a', character: '山', timestamp: 2 })
    await db.logs.bulkAdd([r1, r2])

    expect(await dedupeLocalLogs()).toBe(0)
  })
})
