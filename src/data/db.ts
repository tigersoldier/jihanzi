/**
 * IndexedDB Layer using Dexie.js
 *
 * Manages local persistence of:
 * - Log entries (append-only)
 * - Snapshot (latest compacted state)
 * - App metadata (for sync tracking)
 */

import Dexie, { type Table } from 'dexie'
import type { AnyLogEntry, AppState, ReviewEntry, Snapshot } from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'
import { applyEntry } from '../core/log'
import { getProficiency } from '../core/proficiency'
import type { CharacterAnalytics, DailyReviewStats, ReviewFact } from '../core/learningAnalytics'
import { emptyCategoryCounts } from '../core/learningAnalytics'
import { makeDiffKey } from '../utils/logKey'

function parseReviewEventKey(
  eventKey: string,
): { timestamp: number; childId: string; character: string } | undefined {
  const [timestampText, type, childId, ...characterParts] = eventKey.split(':')
  const timestamp = Number(timestampText)
  const character = characterParts.join(':')
  if (type !== 'review' || !Number.isFinite(timestamp) || !childId || !character) return undefined
  return { timestamp, childId, character }
}

/** Database schema version and definition */
class JihanziDB extends Dexie {
  logs!: Table<LogRow, number> // Auto-incrementing primary key
  snapshot!: Table<Snapshot & { type: string; id?: number }, number> // Snapshot table; type: 'current' | 'historical'
  meta!: Table<{ key: string; value: unknown }, string> // 键值元数据表
  reviewFacts!: Table<ReviewFactRow, number>
  dailyReviewStats!: Table<DailyReviewStatsRow, number>
  characterAnalytics!: Table<CharacterAnalyticsRow, number>
  reviewCounts!: Table<ReviewCountRow, [string, string]>
  reviewCountEvents!: Table<ReviewCountEventRow, string>

  constructor() {
    super('jihanzi')

    this.version(1).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey',
      snapshot: '++id, timestamp',
      meta: 'key',
    })

    // v2: add compound index for efficient child+date range queries
    this.version(2).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey]',
      snapshot: '++id, timestamp',
      meta: 'key',
    })

    // v3: add [childId+character] index + snapshot type field for
    // incremental-materialization architecture
    this.version(3)
      .stores({
        logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey], [childId+character]',
        snapshot: '++id, timestamp, type',
        meta: 'key',
      })
      .upgrade(async tx => {
        // Stamp the 'type' field on existing v2 snapshot rows so that
        // getLatestSnapshot() can find them via the new type index.
        const count = await tx.table('snapshot').count()
        if (count > 0) {
          await tx
            .table('snapshot')
            .toCollection()
            .modify(row => {
              row.type = 'current'
            })
        }
        // Repair any UTF-8 corrupted log entries from the historical
        // Drive encoding bug — iterate oldest-first, stop at first clean.
        await repairCorruptedLogs()
      })

    this.version(4).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey], [childId+character], [timestamp+id]',
      snapshot: '++id, timestamp, type',
      meta: 'key',
      reviewFacts: '++id, &[childId+character+dayKey], [childId+dayKey], [childId+character]',
      dailyReviewStats: '++id, &[childId+dayKey]',
      characterAnalytics: '++id, &[childId+character], childId',
    })

    this.version(5).stores({
      logs: '++id, timestamp, type, childId, wordBookId, character, dayKey, [childId+dayKey], [childId+character], [timestamp+id]',
      snapshot: '++id, timestamp, type',
      meta: 'key',
      reviewFacts: '++id, &[childId+character+dayKey], [childId+dayKey], [childId+character]',
      dailyReviewStats: '++id, &[childId+dayKey]',
      characterAnalytics: '++id, &[childId+character], childId',
      reviewCounts: '[childId+character], childId',
    })

    // v6: retain identities of pruned reviews to avoid double-counting on sync re-import.
    this.version(6).stores({ reviewCountEvents: 'eventKey' })

    // v7: add attribution fields so count projections can be rebuilt from prune markers.
    this.version(7)
      .stores({
        reviewCountEvents:
          'eventKey, timestamp, childId, [childId+character], legacyUnattributable',
      })
      .upgrade(async tx => {
        await tx
          .table('reviewCountEvents')
          .toCollection()
          .modify(row => {
            const parsed = parseReviewEventKey(row.eventKey)
            if (parsed) {
              Object.assign(row, parsed)
              delete row.logId
            } else {
              row.legacyUnattributable = 1
              delete row.logId
            }
          })
      })
  }
}

/** IndexedDB 日志行：Dexie 自动附加的自增主键 id */
type LogRow = AnyLogEntry & { id?: number }
type ReviewFactRow = ReviewFact & { id?: number }
type DailyReviewStatsRow = DailyReviewStats & { id?: number }
type CharacterAnalyticsRow = CharacterAnalytics & { id?: number }
type ReviewCountRow = { childId: string; character: string; count: number }
type ReviewCountEventRow = {
  eventKey: string
  timestamp?: number
  childId?: string
  character?: string
  legacyUnattributable?: 1
}

const db = new JihanziDB()

function withoutLocalLogId(entry: AnyLogEntry): AnyLogEntry {
  const copy = { ...entry } as AnyLogEntry & { id?: number }
  delete copy.id
  return copy
}

export interface AnalyticsReviewUpdate {
  isNew: boolean
  accepted?: boolean
  wasMastered?: boolean
  isMastered?: boolean
}

const analyticsTables = [
  db.logs,
  db.snapshot,
  db.reviewFacts,
  db.dailyReviewStats,
  db.characterAnalytics,
  db.reviewCounts,
] as const

function applyFactDelta(row: DailyReviewStatsRow, fact: ReviewFact, delta: number): void {
  const category = fact.isNew ? row.newChars : row.learnedChars
  category[fact.grade] = Math.max(0, category[fact.grade] + delta)
}

function compareRecentFacts(
  a: CharacterAnalytics['recentLearnedFacts'][number],
  b: CharacterAnalytics['recentLearnedFacts'][number],
): number {
  return b.dayKey.localeCompare(a.dayKey) || b.timestamp - a.timestamp
}

async function recomputeRecentFacts(childId: string, character: string): Promise<void> {
  const row =
    (await db.characterAnalytics
      .where('[childId+character]')
      .equals([childId, character])
      .first()) ??
    ({
      childId,
      character,
      recentLearnedFacts: [],
      everForgottenAfterMastery: false,
      currentlyForgottenAfterMastery: false,
    } satisfies CharacterAnalyticsRow)
  // 每字只有一个初学日事实；反向最多取六条即可跳过它并保留最近五条已学事实。
  const facts = await db.reviewFacts
    .where('[childId+character+dayKey]')
    .between([childId, character, ''], [childId, character, '\uffff'], true, true)
    .reverse()
    .limit(6)
    .toArray()
  row.recentLearnedFacts = facts
    .filter(fact => !fact.isNew)
    .slice(0, 5)
    .map(({ dayKey, timestamp, grade, isNew }) => ({ dayKey, timestamp, grade, isNew }))
  await db.characterAnalytics.put(row)
}

async function upsertReviewFact(entry: ReviewEntry, isNew: boolean): Promise<boolean> {
  if (entry.round !== 1) return false
  const candidate: ReviewFact = {
    childId: entry.childId,
    character: entry.character,
    dayKey: entry.dayKey,
    timestamp: entry.timestamp,
    grade: entry.grade,
    isNew,
  }
  const existing = await db.reviewFacts
    .where('[childId+character+dayKey]')
    .equals([entry.childId, entry.character, entry.dayKey])
    .first()
  let shouldRecompute = false
  if (existing && existing.timestamp < candidate.timestamp) return false
  if (existing && existing.timestamp === candidate.timestamp && existing.grade !== candidate.grade)
    return false
  if (
    existing &&
    existing.timestamp === candidate.timestamp &&
    existing.grade === candidate.grade &&
    existing.isNew === candidate.isNew
  )
    return false

  const stats =
    (await db.dailyReviewStats
      .where('[childId+dayKey]')
      .equals([entry.childId, entry.dayKey])
      .first()) ??
    ({
      childId: entry.childId,
      dayKey: entry.dayKey,
      ...emptyCategoryCounts(),
    } satisfies DailyReviewStatsRow)
  if (existing) {
    applyFactDelta(stats, existing, -1)
    shouldRecompute = true
  }
  applyFactDelta(stats, candidate, 1)
  await db.dailyReviewStats.put(stats)
  await db.reviewFacts.put({
    ...candidate,
    ...(existing?.id !== undefined ? { id: existing.id } : {}),
  })

  if (shouldRecompute) {
    await recomputeRecentFacts(entry.childId, entry.character)
  } else if (!isNew) {
    const row =
      (await db.characterAnalytics
        .where('[childId+character]')
        .equals([entry.childId, entry.character])
        .first()) ??
      ({
        childId: entry.childId,
        character: entry.character,
        recentLearnedFacts: [],
        everForgottenAfterMastery: false,
        currentlyForgottenAfterMastery: false,
      } satisfies CharacterAnalyticsRow)
    row.recentLearnedFacts = [...row.recentLearnedFacts, candidate]
      .sort(compareRecentFacts)
      .slice(0, 5)
    await db.characterAnalytics.put(row)
  } else {
    const existingAnalytics = await db.characterAnalytics
      .where('[childId+character]')
      .equals([entry.childId, entry.character])
      .first()
    if (!existingAnalytics) {
      await db.characterAnalytics.add({
        childId: entry.childId,
        character: entry.character,
        recentLearnedFacts: [],
        everForgottenAfterMastery: false,
        currentlyForgottenAfterMastery: false,
      })
    }
  }
  return true
}

async function reclassifyReviewFact(fact: ReviewFactRow, isNew: boolean): Promise<void> {
  const stats =
    (await db.dailyReviewStats
      .where('[childId+dayKey]')
      .equals([fact.childId, fact.dayKey])
      .first()) ??
    ({
      childId: fact.childId,
      dayKey: fact.dayKey,
      ...emptyCategoryCounts(),
    } satisfies DailyReviewStatsRow)
  const corrected = { ...fact, isNew }
  applyFactDelta(stats, fact, -1)
  applyFactDelta(stats, corrected, 1)
  await db.dailyReviewStats.put(stats)
  await db.reviewFacts.put(corrected)
}

async function updateMasteryRelapse(
  entry: ReviewEntry,
  update: AnalyticsReviewUpdate,
): Promise<boolean> {
  if (entry.round !== 1 || !update.accepted) return false
  const existing = await db.characterAnalytics
    .where('[childId+character]')
    .equals([entry.childId, entry.character])
    .first()
  const row =
    existing ??
    ({
      childId: entry.childId,
      character: entry.character,
      recentLearnedFacts: [],
      everForgottenAfterMastery: false,
      currentlyForgottenAfterMastery: false,
    } satisfies CharacterAnalyticsRow)
  const before = JSON.stringify(row)
  if (entry.grade === 'd' && update.wasMastered && !update.isMastered) {
    row.everForgottenAfterMastery = true
    if (
      row.lastMasteryStatusTimestamp === undefined ||
      entry.timestamp >= row.lastMasteryStatusTimestamp
    ) {
      row.currentlyForgottenAfterMastery = true
      row.lastMasteryStatusTimestamp = entry.timestamp
    }
  } else if (
    update.isMastered &&
    (row.lastMasteryStatusTimestamp === undefined ||
      entry.timestamp >= row.lastMasteryStatusTimestamp)
  ) {
    row.currentlyForgottenAfterMastery = false
    row.lastMasteryStatusTimestamp = entry.timestamp
  }
  if (existing && JSON.stringify(row) === before) return false
  await db.characterAnalytics.put(row)
  return true
}

async function projectReviewEntry(
  entry: AnyLogEntry,
  update?: AnalyticsReviewUpdate,
): Promise<boolean> {
  if (entry.type !== 'review' || entry.round !== 1) return false
  let changed = await upsertReviewFact(entry, update?.isNew ?? false)
  if (update) changed = (await updateMasteryRelapse(entry, update)) || changed
  return changed
}

/** Type guard: filter AnyLogEntry[] down to ReviewEntry[] at runtime */
function filterReviews(entries: AnyLogEntry[]): ReviewEntry[] {
  return entries.filter((e): e is ReviewEntry => e.type === 'review')
}

// ============================================================
// UTF-8 Corruption Detection & Repair
// ============================================================

/**
 * Check whether a string contains UTF-8 corruption.
 *
 * Detects two classes of corruption:
 * 1. Lone surrogates (U+D800–U+DFFF) — invalid UTF-16 that cannot
 *    be encoded to valid UTF-8.
 * 2. C1 control characters (U+0080–U+009F) — these almost never appear
 *    in valid text and are a strong signal of UTF-8 bytes being
 *    misinterpreted as Latin-1 (mojibake).
 */
export function isUTF8Corrupted(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code >= 0xdc00) return true // Lone low surrogate
      if (i + 1 >= str.length || str.charCodeAt(i + 1) < 0xdc00 || str.charCodeAt(i + 1) > 0xdfff) {
        return true // Lone high surrogate
      }
      i++
      continue
    }
    if (code >= 0x0080 && code <= 0x009f) return true
  }
  return false
}

/** Check if a log entry has a character field */
function hasCharacter(entry: AnyLogEntry): entry is AnyLogEntry & { character: string } {
  return 'character' in entry && typeof entry.character === 'string'
}

/**
 * Repair UTF-8 corrupted log entries during v2→v3 migration.
 *
 * Iterates log entries one-by-one from the oldest. If an entry contains
 * corrupted character data it is collected for deletion. Once a clean
 * entry is found, iteration stops — all subsequent entries are assumed
 * clean because the encoding bug has been fixed in current code.
 *
 * Returns the count of deleted entries.
 */
export async function repairCorruptedLogs(): Promise<number> {
  const toDelete: number[] = []
  let foundClean = false

  await db.logs
    .orderBy('timestamp')
    .until(() => foundClean)
    .each(entry => {
      if (hasCharacter(entry) && isUTF8Corrupted(entry.character)) {
        const id = entry.id
        if (typeof id === 'number') {
          toDelete.push(id)
        }
      } else if (hasCharacter(entry)) {
        // First clean entry with a character field — stop iterating
        foundClean = true
      }
    })

  if (toDelete.length > 0) {
    await db.logs.bulkDelete(toDelete)
  }
  return toDelete.length
}

// ============================================================
// Log Operations
// ============================================================

interface ReviewCountBackfillCheckpoint {
  version: number
  phase: 'ledger' | 'logs'
  lastEventKey?: string
  lastId: number
  processed: number
  ready: boolean
}

interface ReviewCountDelta {
  childId: string
  character: string
  delta: number
}

interface ReviewCountPair {
  childId: string
  character: string
}

interface LogDedupeStamp {
  count: number
  lastId: number | null
}

export class ReviewCountMigrationError extends Error {
  constructor(message = '复习次数数据无法安全迁移，请先修复本地数据库。') {
    super(message)
    this.name = 'ReviewCountMigrationError'
  }
}

const REVIEW_COUNT_BACKFILL_KEY = 'wordBookReviewCountsBackfill'
const REVIEW_COUNT_BACKFILL_VERSION = 2
const REVIEW_COUNT_BACKFILL_BATCH_SIZE = 500
let reviewCountBackfillPromise: Promise<void> | null = null
let logDedupeStamp: LogDedupeStamp | null = null
let logDedupePromise: Promise<{ deleted: number; deferred: boolean }> | null = null

async function getReviewCountBackfillCheckpoint(): Promise<
  ReviewCountBackfillCheckpoint | undefined
> {
  const row = await db.meta.get(REVIEW_COUNT_BACKFILL_KEY)
  return row?.value as ReviewCountBackfillCheckpoint | undefined
}

function countPairKey(childId: string, character: string): string {
  return JSON.stringify([childId, character])
}

function collectReviewCountDeltas(
  entries: AnyLogEntry[],
  delta: number,
): Map<string, ReviewCountDelta> {
  const deltas = new Map<string, ReviewCountDelta>()
  for (const entry of entries) {
    if (entry.type !== 'review') continue
    const key = countPairKey(entry.childId, entry.character)
    const existing = deltas.get(key)
    if (existing) existing.delta += delta
    else deltas.set(key, { childId: entry.childId, character: entry.character, delta })
  }
  return deltas
}

function collectReviewEventDeltas(events: ReviewCountEventRow[]): Map<string, ReviewCountDelta> {
  const deltas = new Map<string, ReviewCountDelta>()
  for (const event of events) {
    if (event.childId === undefined || event.character === undefined) continue
    const key = countPairKey(event.childId, event.character)
    const existing = deltas.get(key)
    if (existing) existing.delta++
    else deltas.set(key, { childId: event.childId, character: event.character, delta: 1 })
  }
  return deltas
}

/** 在包含 reviewCounts 的写事务中应用累计次数增量。 */
async function applyReviewCountDeltas(deltas: Map<string, ReviewCountDelta>): Promise<void> {
  for (const { childId, character, delta } of deltas.values()) {
    const key: [string, string] = [childId, character]
    const existing = await db.reviewCounts.get(key)
    const count = Math.max(0, (existing?.count ?? 0) + delta)
    if (count === 0) await db.reviewCounts.delete(key)
    else await db.reviewCounts.put({ childId, character, count })
  }
}

async function getReviewCountEventRows(
  keys: string[],
): Promise<Array<ReviewCountEventRow | undefined>> {
  const rows: Array<ReviewCountEventRow | undefined> = []
  for (let i = 0; i < keys.length; i += REVIEW_COUNT_BACKFILL_BATCH_SIZE) {
    rows.push(
      ...((await db.reviewCountEvents.bulkGet(
        keys.slice(i, i + REVIEW_COUNT_BACKFILL_BATCH_SIZE),
      )) as Array<ReviewCountEventRow | undefined>),
    )
  }
  return rows
}

async function hasUnattributableReviewCountEvents(): Promise<boolean> {
  return (await db.reviewCountEvents.where('legacyUnattributable').equals(1).count()) > 0
}

async function reconcileReviewCountPairs(pairs: Map<string, ReviewCountPair>): Promise<void> {
  for (const { childId, character } of pairs.values()) {
    const [logs, events] = await Promise.all([
      db.logs.where('[childId+character]').equals([childId, character]).toArray(),
      db.reviewCountEvents.where('[childId+character]').equals([childId, character]).toArray(),
    ])
    const eventKeys = new Set<string>()
    for (const entry of logs) {
      if (entry.type === 'review') eventKeys.add(makeDiffKey(entry))
    }
    for (const event of events) eventKeys.add(event.eventKey)

    const key: [string, string] = [childId, character]
    const count = eventKeys.size
    if (count === 0) await db.reviewCounts.delete(key)
    else await db.reviewCounts.put({ childId, character, count })
  }
}

async function addReviewCountDeltasIfReady(entries: AnyLogEntry[]): Promise<void> {
  if (!entries.some(entry => entry.type === 'review')) return
  const checkpoint = await getReviewCountBackfillCheckpoint()
  if (checkpoint?.version !== REVIEW_COUNT_BACKFILL_VERSION || !checkpoint.ready) return
  await applyReviewCountDeltas(collectReviewCountDeltas(entries, 1))
}

interface FilteredReviewEntries {
  toAppend: Array<{ entry: AnyLogEntry; index: number }>
  pruned: Array<{ entry: ReviewEntry; index: number }>
}

/** 按有界批次查重；裁剪标记只阻止重复存储，仍允许状态投影重放。 */
async function filterExistingReviewEntries(
  entries: AnyLogEntry[],
  hasLogs: boolean,
  hasPrunedEvents: boolean,
): Promise<FilteredReviewEntries> {
  const reviewEntries = entries.filter((entry): entry is ReviewEntry => entry.type === 'review')
  const timestamps = [...new Set(reviewEntries.map(entry => entry.timestamp))]
  const reviewEventKeys = [...new Set(reviewEntries.map(makeDiffKey))]
  const existingReviewKeys = new Set<string>()

  if (timestamps.length > 0 && hasLogs) {
    for (let i = 0; i < timestamps.length; i += REVIEW_COUNT_BACKFILL_BATCH_SIZE) {
      const rows = await db.logs
        .where('timestamp')
        .anyOf(timestamps.slice(i, i + REVIEW_COUNT_BACKFILL_BATCH_SIZE))
        .toArray()
      for (const entry of rows) {
        if (entry.type === 'review') existingReviewKeys.add(makeDiffKey(entry))
      }
    }
  }

  const prunedEventKeys = new Set<string>()
  if (reviewEventKeys.length > 0 && hasPrunedEvents) {
    const events = await getReviewCountEventRows(reviewEventKeys)
    for (const event of events) {
      if (event) prunedEventKeys.add(event.eventKey)
    }
  }

  const seen = new Set([...existingReviewKeys, ...prunedEventKeys])
  const projectedPruned = new Set<string>()
  const result: FilteredReviewEntries = { toAppend: [], pruned: [] }
  for (const [index, entry] of entries.entries()) {
    if (entry.type !== 'review') {
      result.toAppend.push({ entry, index })
      continue
    }

    const key = makeDiffKey(entry)
    if (seen.has(key)) {
      if (prunedEventKeys.has(key) && !existingReviewKeys.has(key) && !projectedPruned.has(key)) {
        result.pruned.push({ entry, index })
        projectedPruned.add(key)
      }
      continue
    }
    seen.add(key)
    result.toAppend.push({ entry, index })
  }
  return result
}

async function getLogDedupeStampInTransaction(): Promise<LogDedupeStamp> {
  const [count, last] = await Promise.all([db.logs.count(), db.logs.orderBy('id').last()])
  return { count, lastId: last?.id ?? null }
}

function sameLogDedupeStamp(a: LogDedupeStamp | null, b: LogDedupeStamp): boolean {
  return a !== null && a.count === b.count && a.lastId === b.lastId
}

async function dedupeLogsInTransaction(): Promise<{
  deleted: number
  pairs: Map<string, ReviewCountPair>
}> {
  let currentTimestamp: number | undefined
  const seenAtTimestamp = new Set<string>()
  const toDelete: number[] = []
  const pairs = new Map<string, ReviewCountPair>()
  // Identical makeDiffKey values always share a timestamp. Ordering by timestamp
  // keeps the seen set bounded to one timestamp group; ties retain the lowest id.
  await db.logs.orderBy('timestamp').each(entry => {
    if (entry.timestamp !== currentTimestamp) {
      currentTimestamp = entry.timestamp
      seenAtTimestamp.clear()
    }
    const key = makeDiffKey(entry)
    if (!seenAtTimestamp.has(key)) {
      seenAtTimestamp.add(key)
      return
    }
    if (entry.type === 'review') {
      pairs.set(countPairKey(entry.childId, entry.character), {
        childId: entry.childId,
        character: entry.character,
      })
    }
    if (typeof entry.id === 'number') toDelete.push(entry.id)
  })
  if (toDelete.length > 0) await db.logs.bulkDelete(toDelete)
  return { deleted: toDelete.length, pairs }
}

async function runDedupeTransaction(
  force: boolean,
): Promise<{ deleted: number; deferred: boolean; stamp?: LogDedupeStamp }> {
  return db.transaction(
    'rw',
    [db.logs, db.reviewCounts, db.reviewCountEvents, db.meta],
    async () => {
      const checkpoint = await getReviewCountBackfillCheckpoint()
      if (checkpoint?.version === REVIEW_COUNT_BACKFILL_VERSION && !checkpoint.ready) {
        return { deleted: 0, deferred: true }
      }

      const before = await getLogDedupeStampInTransaction()
      if (!force && sameLogDedupeStamp(logDedupeStamp, before)) {
        return { deleted: 0, deferred: false, stamp: before }
      }

      const { deleted, pairs } = await dedupeLogsInTransaction()
      if (checkpoint?.ready && !(await hasUnattributableReviewCountEvents())) {
        await reconcileReviewCountPairs(pairs)
      }
      return {
        deleted,
        deferred: false,
        stamp: await getLogDedupeStampInTransaction(),
      }
    },
  )
}

async function runDedupe(force = false): Promise<{ deleted: number; deferred: boolean }> {
  if (!logDedupePromise) {
    logDedupePromise = runDedupeTransaction(force)
      .then(result => {
        if (result.stamp) logDedupeStamp = result.stamp
        return { deleted: result.deleted, deferred: result.deferred }
      })
      .finally(() => {
        logDedupePromise = null
      })
  }
  return logDedupePromise
}

/** 修复重复日志；回填期间先等待，避免与分阶段重建交错。 */
export async function dedupeLocalLogs(force = false): Promise<number> {
  const checkpoint = await getReviewCountBackfillCheckpoint()
  if (checkpoint?.version === REVIEW_COUNT_BACKFILL_VERSION && !checkpoint.ready) {
    await backfillReviewCounts()
  }
  const result = await runDedupe(force)
  if (result.deferred) {
    await backfillReviewCounts()
    return dedupeLocalLogs(force)
  }
  return result.deleted
}

async function initializeReviewCountBackfill(): Promise<ReviewCountBackfillCheckpoint> {
  const result = await db.transaction(
    'rw',
    [db.logs, db.reviewCounts, db.reviewCountEvents, db.meta],
    async () => {
      const existing = await getReviewCountBackfillCheckpoint()
      if (existing?.version === REVIEW_COUNT_BACKFILL_VERSION) {
        return { checkpoint: existing, stamp: await getLogDedupeStampInTransaction() }
      }

      if (await hasUnattributableReviewCountEvents()) {
        throw new ReviewCountMigrationError()
      }

      const currentStamp = await getLogDedupeStampInTransaction()
      if (!sameLogDedupeStamp(logDedupeStamp, currentStamp)) {
        await dedupeLogsInTransaction()
      }
      await db.reviewCounts.clear()
      const checkpoint: ReviewCountBackfillCheckpoint = {
        version: REVIEW_COUNT_BACKFILL_VERSION,
        phase: 'ledger',
        lastEventKey: undefined,
        lastId: 0,
        processed: 0,
        ready: false,
      }
      await db.meta.put({ key: REVIEW_COUNT_BACKFILL_KEY, value: checkpoint })
      return { checkpoint, stamp: await getLogDedupeStampInTransaction() }
    },
  )
  logDedupeStamp = result.stamp
  return result.checkpoint
}

async function runReviewCountBackfill(): Promise<void> {
  const checkpoint = await getReviewCountBackfillCheckpoint()
  if (checkpoint?.version === REVIEW_COUNT_BACKFILL_VERSION && checkpoint.ready) return

  if (checkpoint?.version !== REVIEW_COUNT_BACKFILL_VERSION) {
    const dedupe = await runDedupe()
    if (!dedupe.deferred) await initializeReviewCountBackfill()
  }

  while (true) {
    const ready = await db.transaction(
      'rw',
      [db.logs, db.reviewCounts, db.reviewCountEvents, db.meta],
      async () => {
        const current = await getReviewCountBackfillCheckpoint()
        if (!current || current.version !== REVIEW_COUNT_BACKFILL_VERSION) {
          throw new ReviewCountMigrationError(
            '复习次数回填检查点已丢失或版本不匹配，请重新加载后重试。',
          )
        }
        if (current.ready) return true

        if (current.phase === 'ledger') {
          const batch = await db.reviewCountEvents
            .where('eventKey')
            .above(current.lastEventKey ?? '')
            .limit(REVIEW_COUNT_BACKFILL_BATCH_SIZE)
            .toArray()
          if (batch.length > 0) {
            await applyReviewCountDeltas(collectReviewEventDeltas(batch))
            current.lastEventKey = batch[batch.length - 1].eventKey
            current.processed += batch.length
          }
          if (batch.length < REVIEW_COUNT_BACKFILL_BATCH_SIZE) {
            current.phase = 'logs'
            current.lastId = 0
          }
          await db.meta.put({ key: REVIEW_COUNT_BACKFILL_KEY, value: current })
          return false
        }

        const batch = await db.logs
          .where('id')
          .above(current.lastId)
          .limit(REVIEW_COUNT_BACKFILL_BATCH_SIZE)
          .toArray()
        if (batch.length > 0) {
          const keys = [...new Set(batch.filter(entry => entry.type === 'review').map(makeDiffKey))]
          const markerRows = await getReviewCountEventRows(keys)
          const prunedKeys = new Set(markerRows.flatMap(event => (event ? [event.eventKey] : [])))
          const countable = batch.filter(
            entry => entry.type !== 'review' || !prunedKeys.has(makeDiffKey(entry)),
          )
          await applyReviewCountDeltas(collectReviewCountDeltas(countable, 1))
          current.lastId = batch[batch.length - 1].id ?? current.lastId
          current.processed += batch.length
        }
        current.ready = batch.length < REVIEW_COUNT_BACKFILL_BATCH_SIZE
        await db.meta.put({ key: REVIEW_COUNT_BACKFILL_KEY, value: current })
        return current.ready
      },
    )
    if (ready) return
  }
}

/** 先迁移裁剪事件，再扫描保留日志；检查点允许中断后续跑。 */
export function backfillReviewCounts(): Promise<void> {
  if (!reviewCountBackfillPromise) {
    reviewCountBackfillPromise = runReviewCountBackfill().finally(() => {
      reviewCountBackfillPromise = null
    })
  }
  return reviewCountBackfillPromise
}

/** 追加日志并在同一事务中更新本地统计投影；重复复习返回 null。 */
export async function appendLog(
  entry: AnyLogEntry,
  analyticsUpdate?: AnalyticsReviewUpdate,
): Promise<number | null> {
  const id = await db.transaction(
    'rw',
    [...analyticsTables, db.meta, db.reviewCountEvents],
    async () => {
      if (entry.type === 'review') {
        const key = makeDiffKey(entry)
        if (await db.reviewCountEvents.get(key)) return null

        const existing = await db.logs
          .where('timestamp')
          .equals(entry.timestamp)
          .filter(row => row.type === 'review' && makeDiffKey(row) === key)
          .first()
        if (existing) return null
      }

      const newId = await db.logs.add(withoutLocalLogId(entry))
      await projectReviewEntry(entry, analyticsUpdate)
      await addReviewCountDeltasIfReady([entry])
      return newId
    },
  )
  if (id !== null) logDedupeStamp = null
  return id
}

async function projectPrunedReviewEntry(
  entry: ReviewEntry,
  analyticsUpdate: AnalyticsReviewUpdate | undefined,
  children: Map<string, AppState['children'][number]>,
): Promise<boolean> {
  if (entry.round !== 1) return false
  const existingFact = await db.reviewFacts
    .where('[childId+character+dayKey]')
    .equals([entry.childId, entry.character, entry.dayKey])
    .first()
  const firstReviewDay = children.get(entry.childId)?.progress[entry.character]?.firstReviewDay
  const isNew =
    analyticsUpdate?.isNew ??
    (firstReviewDay !== undefined ? firstReviewDay === entry.dayKey : (existingFact?.isNew ?? true))
  const update = analyticsUpdate ? { ...analyticsUpdate, isNew } : { isNew }
  return projectReviewEntry(entry, update)
}

export interface AppendLogsResult {
  appendedCount: number
  projectionsChanged: boolean
}

/** 批量追加日志；裁剪标记不挡住状态投影重放。 */
export async function appendLogs(
  entries: AnyLogEntry[],
  analyticsUpdates: Array<AnalyticsReviewUpdate | undefined> = [],
): Promise<AppendLogsResult> {
  if (entries.length === 0) return { appendedCount: 0, projectionsChanged: false }

  const result = await db.transaction(
    'rw',
    [...analyticsTables, db.meta, db.reviewCountEvents],
    async () => {
      const snapshot = await getLatestSnapshot()
      const children = new Map(snapshot?.state.children.map(child => [child.id, child]) ?? [])
      let appendedCount = 0
      let projectionsChanged = false
      let hasLogs = Boolean(await db.logs.orderBy('id').first())
      const hasPrunedEvents = Boolean(await db.reviewCountEvents.orderBy('eventKey').first())

      for (let offset = 0; offset < entries.length; offset += REVIEW_COUNT_BACKFILL_BATCH_SIZE) {
        const batch = entries.slice(offset, offset + REVIEW_COUNT_BACKFILL_BATCH_SIZE)
        const { toAppend, pruned } = await filterExistingReviewEntries(
          batch,
          hasLogs,
          hasPrunedEvents,
        )
        if (toAppend.length > 0) {
          await db.logs.bulkAdd(toAppend.map(({ entry }) => withoutLocalLogId(entry)))
          hasLogs = true
        }

        for (const { entry, index } of toAppend) {
          if (entry.type !== 'review' || entry.round !== 1) continue
          let update = analyticsUpdates[offset + index]
          if (!update && entry.type === 'review' && entry.round === 1) {
            const firstReviewDay = children.get(entry.childId)?.progress[entry.character]
              ?.firstReviewDay
            update = { isNew: firstReviewDay === undefined || firstReviewDay === entry.dayKey }
          }
          projectionsChanged = (await projectReviewEntry(entry, update)) || projectionsChanged
        }
        for (const { entry, index } of pruned) {
          if (entry.round !== 1) continue
          projectionsChanged =
            (await projectPrunedReviewEntry(entry, analyticsUpdates[offset + index], children)) ||
            projectionsChanged
        }

        await addReviewCountDeltasIfReady(toAppend.map(({ entry }) => entry))
        appendedCount += toAppend.length
      }
      return { appendedCount, projectionsChanged }
    },
  )
  if (result.appendedCount > 0) logDedupeStamp = null
  return result
}

export interface AnalyticsBackfillStatus {
  ready: boolean
  processed: number
  total: number
  phase?: 'facts' | 'logs'
}

interface AnalyticsBackfillCheckpoint extends AnalyticsBackfillStatus {
  version: number
  phase: 'facts' | 'logs'
  lastFactId?: number
  lastTimestamp?: number
  lastId?: number
  replayState?: AppState
}

const ANALYTICS_BACKFILL_KEY = 'learningAnalyticsBackfill'
const ANALYTICS_BACKFILL_VERSION = 3
const ANALYTICS_BACKFILL_BATCH_SIZE = 500

function emptyReplayState(): AppState {
  return {
    children: [],
    wordBooks: [],
    settings: { ...DEFAULT_SETTINGS },
  }
}

export async function getAnalyticsBackfillStatus(): Promise<AnalyticsBackfillStatus> {
  const checkpoint = await getMeta<AnalyticsBackfillCheckpoint>(ANALYTICS_BACKFILL_KEY)
  return checkpoint?.version === ANALYTICS_BACKFILL_VERSION
    ? {
        ready: checkpoint.ready,
        processed: checkpoint.processed,
        total: checkpoint.total,
        phase: checkpoint.phase,
      }
    : { ready: false, processed: 0, total: 0, phase: 'facts' }
}

const backfillListeners = new Set<(status: AnalyticsBackfillStatus) => void>()
let backfillPromise: Promise<void> | null = null

/** 分批校正已有事实并回填日志投影，支持中断后续跑。 */
async function runLearningAnalyticsBackfill(): Promise<void> {
  const existingCheckpoint = await getMeta<AnalyticsBackfillCheckpoint>(ANALYTICS_BACKFILL_KEY)
  if (
    existingCheckpoint?.version === ANALYTICS_BACKFILL_VERSION &&
    existingCheckpoint.ready &&
    !existingCheckpoint.replayState
  )
    return

  const snapshot = await getLatestSnapshot()
  const snapshotFirstReviewDays = new Map<string, string>()
  for (const child of snapshot?.state.children ?? []) {
    for (const [character, progress] of Object.entries(child.progress)) {
      snapshotFirstReviewDays.set(JSON.stringify([child.id, character]), progress.firstReviewDay)
    }
  }

  while (true) {
    const result = (await db.transaction('rw', [...analyticsTables, db.meta], async () => {
      let checkpoint = await db.meta
        .get(ANALYTICS_BACKFILL_KEY)
        .then(row => row?.value as AnalyticsBackfillCheckpoint | undefined)
      if (!checkpoint || checkpoint.version !== ANALYTICS_BACKFILL_VERSION) {
        // 投影算法升级时先重分类已有事实，再从日志起点幂等重放并保留持久化状态。
        checkpoint = {
          version: ANALYTICS_BACKFILL_VERSION,
          phase: 'facts',
          ready: false,
          processed: 0,
          total: await db.reviewFacts.count(),
        }
      }
      if (checkpoint.ready) {
        if (checkpoint.replayState) {
          const { replayState: _completedReplayState, ...completed } = checkpoint
          await db.meta.put({ key: ANALYTICS_BACKFILL_KEY, value: completed })
          return { status: completed, finished: true }
        }
        return { status: checkpoint, finished: true }
      }

      if (checkpoint.phase === 'facts') {
        const facts =
          checkpoint.lastFactId !== undefined
            ? await db.reviewFacts
                .where('id')
                .above(checkpoint.lastFactId)
                .limit(ANALYTICS_BACKFILL_BATCH_SIZE)
                .toArray()
            : await db.reviewFacts.orderBy('id').limit(ANALYTICS_BACKFILL_BATCH_SIZE).toArray()
        const changedCharacters = new Map<string, { childId: string; character: string }>()
        for (const fact of facts) {
          const firstReviewDay = snapshotFirstReviewDays.get(
            JSON.stringify([fact.childId, fact.character]),
          )
          if (firstReviewDay === undefined) continue
          const isNew = firstReviewDay === fact.dayKey
          if (isNew === fact.isNew) continue
          await reclassifyReviewFact(fact, isNew)
          changedCharacters.set(JSON.stringify([fact.childId, fact.character]), {
            childId: fact.childId,
            character: fact.character,
          })
        }
        for (const { childId, character } of changedCharacters.values()) {
          await recomputeRecentFacts(childId, character)
        }

        const lastFact = facts[facts.length - 1]
        const factsReady = facts.length < ANALYTICS_BACKFILL_BATCH_SIZE
        const { lastFactId: _lastFactId, ...checkpointFields } = checkpoint
        const updated: AnalyticsBackfillCheckpoint = {
          ...checkpointFields,
          phase: factsReady ? 'logs' : 'facts',
          processed: factsReady ? 0 : checkpoint.processed + facts.length,
          total: factsReady ? await db.logs.count() : checkpoint.total,
        }
        if (factsReady) updated.replayState = emptyReplayState()
        else if (lastFact?.id !== undefined) updated.lastFactId = lastFact.id
        await db.meta.put({ key: ANALYTICS_BACKFILL_KEY, value: updated })
        return { status: updated, finished: false }
      }

      const batch =
        checkpoint.lastTimestamp !== undefined && checkpoint.lastId !== undefined
          ? await db.logs
              .where('[timestamp+id]')
              .above([checkpoint.lastTimestamp, checkpoint.lastId])
              .limit(ANALYTICS_BACKFILL_BATCH_SIZE)
              .toArray()
          : await db.logs.orderBy('[timestamp+id]').limit(ANALYTICS_BACKFILL_BATCH_SIZE).toArray()
      const replayState = checkpoint.replayState ?? emptyReplayState()

      for (const row of batch) {
        if (row.type === 'review' && row.round === 1) {
          const child = replayState.children.find(item => item.id === row.childId)
          const previous = child?.progress[row.character]
          const wasMastered = getProficiency(previous) === 'mastered'
          const accepted = applyEntry(replayState, row)
          const current = replayState.children.find(item => item.id === row.childId)?.progress[
            row.character
          ]
          const snapshotFirstReviewDay = snapshotFirstReviewDays.get(
            JSON.stringify([row.childId, row.character]),
          )
          const firstReviewDay = snapshotFirstReviewDay ?? previous?.firstReviewDay
          await projectReviewEntry(row, {
            isNew:
              firstReviewDay !== undefined ? firstReviewDay === row.dayKey : previous === undefined,
            accepted,
            wasMastered,
            isMastered: getProficiency(current) === 'mastered',
          })
        } else {
          applyEntry(replayState, row)
        }
      }

      const last = batch[batch.length - 1]
      const processed = checkpoint.processed + batch.length
      const ready = batch.length < ANALYTICS_BACKFILL_BATCH_SIZE
      const { replayState: _previousReplayState, ...checkpointFields } = checkpoint
      const updated: AnalyticsBackfillCheckpoint = {
        ...checkpointFields,
        ready,
        processed,
      }
      if (!ready) updated.replayState = replayState
      if (last) {
        updated.lastTimestamp = last.timestamp
        updated.lastId = last.id
      }
      await db.meta.put({ key: ANALYTICS_BACKFILL_KEY, value: updated })
      return { status: updated, finished: updated.ready }
    })) as { status: AnalyticsBackfillCheckpoint; finished: boolean }
    const status = {
      ready: result.status.ready,
      processed: result.status.processed,
      total: result.status.total,
      phase: result.status.phase,
    }
    backfillListeners.forEach(listener => listener(status))
    if (result.finished) return
  }
}

export function backfillLearningAnalytics(
  onProgress?: (status: AnalyticsBackfillStatus) => void,
): Promise<void> {
  if (onProgress) backfillListeners.add(onProgress)
  if (!backfillPromise) {
    backfillPromise = runLearningAnalyticsBackfill().finally(() => {
      backfillPromise = null
    })
  }
  const running = backfillPromise
  return running.finally(() => {
    if (onProgress) backfillListeners.delete(onProgress)
  })
}

export async function getDailyReviewStatsForDay(
  childId: string,
  dayKey: string,
): Promise<DailyReviewStats | undefined> {
  return db.dailyReviewStats.where('[childId+dayKey]').equals([childId, dayKey]).first()
}

export async function getDailyReviewStatsInRange(
  childId: string,
  fromDay: string,
  toDay: string,
): Promise<DailyReviewStats[]> {
  return db.dailyReviewStats
    .where('[childId+dayKey]')
    .between([childId, fromDay], [childId, toDay], true, true)
    .toArray()
}

export async function getCharacterAnalyticsForChild(
  childId: string,
): Promise<CharacterAnalytics[]> {
  return db.characterAnalytics.where('childId').equals(childId).toArray()
}

export interface ReconstructedReviewUpdate extends AnalyticsReviewUpdate {
  accepted: boolean
  wasMastered: boolean
  isMastered: boolean
}

/** 用每个受影响汉字的现有日志历史，在临时状态上重建待导入评级的统计结果。 */
export async function reconstructReviewAnalyticsUpdates(
  incoming: AnyLogEntry[],
  watermark?: number,
): Promise<Map<string, ReconstructedReviewUpdate>> {
  const affected = new Map<
    string,
    { childId: string; character: string; targets: Set<string>; incoming: ReviewEntry[] }
  >()
  for (const entry of incoming) {
    if (entry.type !== 'review') continue
    const key = JSON.stringify([entry.childId, entry.character])
    let group = affected.get(key)
    if (!group) {
      group = {
        childId: entry.childId,
        character: entry.character,
        targets: new Set(),
        incoming: [],
      }
      affected.set(key, group)
    }
    group.incoming.push(entry)
    if (entry.round === 1 && (watermark === undefined || entry.timestamp <= watermark)) {
      group.targets.add(makeDiffKey(entry))
    }
  }

  const outcomes = new Map<string, ReconstructedReviewUpdate>()
  for (const group of affected.values()) {
    if (group.targets.size === 0) continue
    const history = new Map<string, ReviewEntry>()
    for (const entry of await getReviewsForChildChar(group.childId, group.character)) {
      history.set(makeDiffKey(entry), entry)
    }
    for (const entry of group.incoming) {
      const key = makeDiffKey(entry)
      if (!history.has(key)) history.set(key, entry)
    }
    const orderedHistory = [...history.values()].sort((a, b) => a.timestamp - b.timestamp)
    const wordBookId = `analytics_${group.childId}`
    const replayState: AppState = {
      children: [
        {
          id: group.childId,
          name: '',
          wordBookId,
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [{ id: wordBookId, name: '', characters: [group.character] }],
      settings: { ...DEFAULT_SETTINGS },
    }

    for (const entry of orderedHistory) {
      const before = replayState.children[0].progress[group.character]
      const wasMastered = getProficiency(before) === 'mastered'
      const accepted = applyEntry(replayState, entry)
      const after = replayState.children[0].progress[group.character]
      if (group.targets.has(makeDiffKey(entry))) {
        outcomes.set(makeDiffKey(entry), {
          isNew: before === undefined || before.firstReviewDay === entry.dayKey,
          accepted: accepted && entry.round === 1,
          wasMastered,
          isMastered: getProficiency(after) === 'mastered',
        })
      }
    }
  }
  return outcomes
}

export async function recordAppliedReviewAnalytics(
  entry: ReviewEntry,
  wasMastered: boolean,
  isMastered: boolean,
): Promise<void> {
  await db.transaction('rw', db.characterAnalytics, async () => {
    await updateMasteryRelapse(entry, { isNew: false, accepted: true, wasMastered, isMastered })
  })
}

/** Get log entries after a specific timestamp */
export async function getLogsAfter(timestamp: number): Promise<AnyLogEntry[]> {
  return db.logs.where('timestamp').above(timestamp).toArray()
}

/**
 * Get up to `limit` log entries at or after a timestamp, ordered by timestamp ascending.
 * Pass `afterId` (the last-seen entry's auto-increment id) to resume without
 * skipping entries that share the same timestamp as the batch boundary.
 */
export async function getLogsAfterPaginated(
  timestamp: number,
  limit: number,
  afterId?: number,
): Promise<AnyLogEntry[]> {
  const results = await db.logs
    .where('timestamp')
    .aboveOrEqual(timestamp)
    .limit(afterId !== undefined ? limit + 10 : limit)
    .toArray()

  if (afterId !== undefined) {
    return results.filter(e => (e.id as number) > afterId).slice(0, limit)
  }
  return results.slice(0, limit)
}

/** Get the earliest and latest log timestamps in IndexedDB */
export async function getLogTimestampRange(): Promise<{
  earliest: number | null
  latest: number | null
}> {
  const count = await db.logs.count()
  if (count === 0) return { earliest: null, latest: null }

  const first = await db.logs.orderBy('timestamp').first()
  const last = await db.logs.orderBy('timestamp').last()
  return {
    earliest: first?.timestamp ?? null,
    latest: last?.timestamp ?? null,
  }
}

/** Get log count */
export async function getLogCount(): Promise<number> {
  return db.logs.count()
}

/** 将裁剪复习转为可归因的事件标记，并移除本地重复副本。
 * 返回实际删除的日志行数，可能因同事件重复副本而大于 count。
 */
export async function pruneOldestLogs(count: number): Promise<number> {
  await backfillReviewCounts()
  if (count <= 0) return 0

  const deleted = await db.transaction(
    'rw',
    [db.logs, db.reviewCounts, db.reviewCountEvents],
    async () => {
      const oldestLogs = await db.logs.orderBy('timestamp').limit(count).toArray()
      const markerByKey = new Map<string, ReviewCountEventRow>()
      const affectedPairs = new Map<string, ReviewCountPair>()
      for (const entry of oldestLogs) {
        if (entry.type !== 'review') continue
        const eventKey = makeDiffKey(entry)
        markerByKey.set(eventKey, {
          eventKey,
          timestamp: entry.timestamp,
          childId: entry.childId,
          character: entry.character,
        })
        affectedPairs.set(countPairKey(entry.childId, entry.character), {
          childId: entry.childId,
          character: entry.character,
        })
      }
      if (markerByKey.size > 0) await db.reviewCountEvents.bulkPut([...markerByKey.values()])

      const matchedIds = new Set<number>()
      for (const entry of oldestLogs) {
        if (typeof entry.id === 'number') matchedIds.add(entry.id)
      }
      const keys = new Set(markerByKey.keys())
      const timestamps = [...new Set([...markerByKey.values()].map(event => event.timestamp!))]
      for (let i = 0; i < timestamps.length; i += REVIEW_COUNT_BACKFILL_BATCH_SIZE) {
        const rows = await db.logs
          .where('timestamp')
          .anyOf(timestamps.slice(i, i + REVIEW_COUNT_BACKFILL_BATCH_SIZE))
          .toArray()
        for (const row of rows) {
          if (row.type === 'review' && keys.has(makeDiffKey(row)) && typeof row.id === 'number') {
            matchedIds.add(row.id)
          }
        }
      }

      if (matchedIds.size > 0) await db.logs.bulkDelete([...matchedIds])
      if (!(await hasUnattributableReviewCountEvents())) {
        await reconcileReviewCountPairs(affectedPairs)
      }
      return matchedIds.size
    },
  )
  if (deleted > 0) logDedupeStamp = null
  return deleted
}

/** Get reviews for a specific child — uses childId index, filterReviews 处理 type */
export async function getReviewsForChild(childId: string): Promise<ReviewEntry[]> {
  return db.logs.where('childId').equals(childId).toArray().then(filterReviews)
}

/** Read the persistent per-character review totals for one child. */
export async function getReviewCountsForChild(childId: string): Promise<Record<string, number>> {
  await backfillReviewCounts()
  if (await hasUnattributableReviewCountEvents()) throw new ReviewCountMigrationError()
  const rows = await db.reviewCounts.where('childId').equals(childId).toArray()
  return Object.fromEntries(rows.map(row => [row.character, row.count]))
}

/** Get all reviews for a specific child and character — uses [childId+character] index, filterReviews 处理 type */
export async function getReviewsForChildChar(
  childId: string,
  character: string,
): Promise<ReviewEntry[]> {
  return db.logs.where({ childId, character }).toArray().then(filterReviews)
}

/**
 * 分页获取指定孩子和字的复习记录 — cursor-based 分页。
 *
 * 利用 [childId+character] 复合索引中同键值记录按主键排序的特性：
 * reverse() 取最新（id 最大）在前，filter 限定 type==='review'，
 * limit(N) 限制每次最多读 N 条（不会物化全量记录）。
 *
 * 每次多取 1 条以判断 hasMore：load 51 条，返回最多 50 条 + cursor。
 * 多取的第 51 条在下一页作为第一条被重新读出，确保不丢数据。
 * 下一轮传入 cursor（上一页最后一条的 id）获取更早的条目。
 */
export async function getReviewsForChildCharPaginated(
  childId: string,
  character: string,
  limit: number = 51,
  afterId?: number,
): Promise<{ entries: ReviewEntry[]; hasMore: boolean; cursor: number | null }> {
  let collection = db.logs.where({ childId, character }).filter(e => e.type === 'review')

  // 游标分页：reverse 下 id 从大到小，只取 id < afterId 的更早记录
  if (afterId !== undefined) {
    collection = collection.filter(e => (e.id as number) < afterId)
  }

  const entries = (await collection.reverse().limit(limit).toArray()) as (ReviewEntry & {
    id: number
  })[]

  const hasMore = entries.length === limit
  const result = entries.slice(0, limit - 1) as ReviewEntry[]

  return {
    entries: result,
    hasMore,
    cursor:
      result.length > 0 ? (result[result.length - 1] as ReviewEntry & { id: number }).id : null,
  }
}

/** Get reviews for a child within a dayKey range (inclusive) */
export async function getReviewsForChildInRange(
  childId: string,
  fromDay: string,
  toDay: string,
): Promise<ReviewEntry[]> {
  const result = await db.logs
    .where('[childId+dayKey]')
    .between([childId, fromDay], [childId, toDay], true, true)
    .filter(r => r.type === 'review')
    .sortBy('dayKey')
    .then(filterReviews)
  return result
}

/** Get round 1 reviews for a specific child on a specific day — uses [childId+dayKey] index */
export async function getReviewsForChildOnDay(
  childId: string,
  dayKey: string,
): Promise<ReviewEntry[]> {
  return db.logs
    .where({ childId, dayKey })
    .filter(e => e.type === 'review' && (e as ReviewEntry).round === 1)
    .toArray()
    .then(filterReviews)
}

/**
 * 找到指定孩子最近一次有复习记录的 dayKey。
 * 用于判断上次学习日的类型（学新 vs 纯复习）。
 * 若无记录返回 undefined。
 */
export async function getLastStudyDayForChild(childId: string): Promise<string | undefined> {
  const entries = await db.logs
    .where('childId')
    .equals(childId)
    .filter(e => e.type === 'review')
    .sortBy('dayKey')
  if (entries.length === 0) return undefined
  return entries[entries.length - 1].dayKey
}

// ============================================================
// Snapshot Operations
// ============================================================

const SNAPSHOT_TYPE_CURRENT = 'current'
const SNAPSHOT_TYPE_HISTORICAL = 'historical'

/** Get the current (latest) snapshot — the source of truth for app state */
export async function getLatestSnapshot(): Promise<Snapshot | null> {
  const result = await db.snapshot.where('type').equals(SNAPSHOT_TYPE_CURRENT).first()
  if (!result) return null
  // Strip the extra 'type' field while preserving the replay watermark.
  return {
    timestamp: result.timestamp,
    ...(result.appliedThrough !== undefined ? { appliedThrough: result.appliedThrough } : {}),
    state: result.state,
  }
}

/** Get all historical snapshots, newest first */
export async function getHistoricalSnapshots(): Promise<Snapshot[]> {
  const rows = await db.snapshot.where('type').equals(SNAPSHOT_TYPE_HISTORICAL).sortBy('timestamp')
  // Most recent first
  return rows.reverse().map(r => ({
    timestamp: r.timestamp,
    ...(r.appliedThrough !== undefined ? { appliedThrough: r.appliedThrough } : {}),
    state: r.state,
  }))
}

/**
 * Find the nearest snapshot whose timestamp is ≤ beforeTimestamp.
 * Searches both current and historical snapshots.
 * Used for remote merge: find the base snapshot to replay from.
 */
/** Save/replace the current snapshot */
export async function saveCurrentSnapshot(snapshot: Snapshot): Promise<void> {
  const row = { ...snapshot, type: SNAPSHOT_TYPE_CURRENT }
  // Delete old current snapshot (there should be at most one)
  await db.snapshot.where('type').equals(SNAPSHOT_TYPE_CURRENT).delete()
  await db.snapshot.add(row)
}

/** Save a historical snapshot at an interval boundary */
export async function saveHistoricalSnapshot(snapshot: Snapshot): Promise<void> {
  const row = { ...snapshot, type: SNAPSHOT_TYPE_HISTORICAL }
  await db.snapshot.add(row)
}

/** Keep only the most recent `keepCount` historical snapshots, delete the rest */
export async function pruneOldSnapshots(keepCount: number): Promise<void> {
  const historical = await db.snapshot
    .where('type')
    .equals(SNAPSHOT_TYPE_HISTORICAL)
    .sortBy('timestamp')
  // Sort newest first, delete everything after keepCount
  historical.reverse()
  const toDelete = historical.slice(keepCount)
  const ids = toDelete.map(r => r.id).filter((id): id is number => id !== undefined)
  if (ids.length > 0) {
    await db.snapshot.bulkDelete(ids)
  }
}

// ============================================================
// Metadata Operations
// ============================================================

/** Get a metadata value */
export async function getMeta<T = unknown>(key: string): Promise<T | undefined> {
  const row = await db.meta.get(key)
  return row?.value as T | undefined
}

/** Set a metadata value */
export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value })
}

/** Get the last known remote timestamp (Drive modifiedTime) */
export async function getLastKnownRemoteTime(): Promise<number> {
  return (await getMeta<number>('lastKnownRemoteTime')) || 0
}

/** Set the last known remote timestamp (Drive modifiedTime) */
export async function setLastKnownRemoteTime(timestamp: number): Promise<void> {
  await setMeta('lastKnownRemoteTime', timestamp)
}

export default db
