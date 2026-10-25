// @vitest-environment node

import 'fake-indexeddb/auto'
import Dexie from 'dexie'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AnyLogEntry } from '../core/types'
import { makeDiffKey } from '../utils/logKey'
import db, {
  getHistoricalSnapshots,
  getLatestSnapshot,
  getReviewCountsForChild,
  ReviewCountMigrationError,
  saveCurrentSnapshot,
  saveHistoricalSnapshot,
} from './db'

const baseStores = {
  logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey], [childId+character], [timestamp+id]',
  snapshot: '++id, timestamp, type',
  meta: 'key',
  reviewFacts: '++id, &[childId+character+dayKey], [childId+dayKey], [childId+character]',
  dailyReviewStats: '++id, &[childId+dayKey]',
  characterAnalytics: '++id, &[childId+character], childId',
}

function makeReview(timestamp: number, character = '花'): AnyLogEntry {
  return {
    timestamp,
    type: 'review',
    childId: 'child-a',
    character,
    grade: 'a',
    round: 1,
    dayKey: '2026-07-01',
  } as AnyLogEntry
}

async function removeDatabase() {
  db.close()
  await Dexie.delete('jihanzi')
}

describe('database schema upgrades', () => {
  beforeEach(removeDatabase)
  afterEach(removeDatabase)

  it('migrates v6 prune keys and rebuilds counts from the distinct ledger/log union', async () => {
    const legacy = new Dexie('jihanzi')
    legacy.version(6).stores({
      ...baseStores,
      reviewCounts: '[childId+character], childId',
      reviewCountEvents: 'eventKey',
    })
    await legacy.open()

    const prunedAndRetained = makeReview(10)
    const retained = makeReview(20)
    const prunedOnly = makeReview(30)
    await legacy.table('logs').bulkAdd([prunedAndRetained, retained, retained])
    await legacy.table('reviewCounts').put({ childId: 'child-a', character: '花', count: 99 })
    await legacy.table('reviewCountEvents').bulkPut([
      { eventKey: makeDiffKey(prunedAndRetained), logId: 1 },
      { eventKey: makeDiffKey(prunedOnly), logId: 500 },
    ])
    await legacy.table('meta').put({
      key: 'wordBookReviewCountsBackfill',
      value: { version: 1, lastId: 3, processed: 3, ready: true },
    })
    legacy.close()
    await db.open()

    await expect(getReviewCountsForChild('child-a')).resolves.toEqual({ 花: 3 })
    expect(await db.logs.count()).toBe(2)
    const migratedMarker = await db.reviewCountEvents.get(makeDiffKey(prunedAndRetained))
    expect(migratedMarker).toMatchObject({
      timestamp: 10,
      childId: 'child-a',
      character: '花',
    })
    expect(migratedMarker).not.toHaveProperty('logId')
    expect(await db.meta.get('wordBookReviewCountsBackfill')).toMatchObject({
      value: { version: 2, ready: true },
    })
  })

  it('keeps prior counts intact and reports unavailable for malformed legacy markers', async () => {
    const legacy = new Dexie('jihanzi')
    legacy.version(6).stores({
      ...baseStores,
      reviewCounts: '[childId+character], childId',
      reviewCountEvents: 'eventKey',
    })
    await legacy.open()
    await legacy.table('reviewCounts').put({ childId: 'child-a', character: '花', count: 9 })
    await legacy.table('reviewCountEvents').put({ eventKey: 'malformed-key', logId: 1 })
    await legacy.table('meta').put({
      key: 'wordBookReviewCountsBackfill',
      value: { version: 1, lastId: 0, processed: 0, ready: true },
    })
    legacy.close()
    await db.open()

    await expect(getReviewCountsForChild('child-a')).rejects.toBeInstanceOf(
      ReviewCountMigrationError,
    )
    expect(await db.reviewCounts.get(['child-a', '花'])).toMatchObject({ count: 9 })
    expect(await db.meta.get('wordBookReviewCountsBackfill')).toMatchObject({
      value: { version: 1, ready: true },
    })
  })

  it('upgrades v4 databases that do not yet have review-count stores', async () => {
    const legacy = new Dexie('jihanzi')
    legacy.version(4).stores(baseStores)
    await legacy.open()
    await legacy.table('logs').add(makeReview(10))
    legacy.close()
    await db.open()

    await expect(getReviewCountsForChild('child-a')).resolves.toEqual({ 花: 1 })
    expect(await db.reviewCountEvents.count()).toBe(0)
  })

  it('preserves appliedThrough on current and historical snapshot reads', async () => {
    await db.open()
    const snapshot = {
      timestamp: 1000,
      appliedThrough: 950,
      state: {
        children: [],
        wordBooks: [],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    await saveCurrentSnapshot(snapshot)
    await saveHistoricalSnapshot(snapshot)

    expect(await getLatestSnapshot()).toEqual(snapshot)
    expect(await getHistoricalSnapshots()).toEqual([snapshot])
  })
})
