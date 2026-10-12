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

/** Database schema version and definition */
class JihanziDB extends Dexie {
  logs!: Table<LogRow, number> // Auto-incrementing primary key
  snapshot!: Table<Snapshot & { type: string; id?: number }, number> // Snapshot table; type: 'current' | 'historical'
  meta!: Table<{ key: string; value: unknown }, string> // 键值元数据表
  reviewFacts!: Table<ReviewFactRow, number>
  dailyReviewStats!: Table<DailyReviewStatsRow, number>
  characterAnalytics!: Table<CharacterAnalyticsRow, number>

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
  }
}

/** IndexedDB 日志行：Dexie 自动附加的自增主键 id */
type LogRow = AnyLogEntry & { id?: number }
type ReviewFactRow = ReviewFact & { id?: number }
type DailyReviewStatsRow = DailyReviewStats & { id?: number }
type CharacterAnalyticsRow = CharacterAnalytics & { id?: number }

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

async function upsertReviewFact(entry: ReviewEntry, isNew: boolean): Promise<void> {
  if (entry.round !== 1) return
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
  if (existing && existing.timestamp < candidate.timestamp) return
  if (existing && existing.timestamp === candidate.timestamp && existing.grade !== candidate.grade)
    return
  if (
    existing &&
    existing.timestamp === candidate.timestamp &&
    existing.grade === candidate.grade &&
    existing.isNew === candidate.isNew
  )
    return

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
}

async function updateMasteryRelapse(
  entry: ReviewEntry,
  update: AnalyticsReviewUpdate,
): Promise<void> {
  if (entry.round !== 1 || !update.accepted) return
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
  await db.characterAnalytics.put(row)
}

async function projectReviewEntry(
  entry: AnyLogEntry,
  update?: AnalyticsReviewUpdate,
): Promise<void> {
  if (entry.type !== 'review' || entry.round !== 1) return
  await upsertReviewFact(entry, update?.isNew ?? false)
  if (update) await updateMasteryRelapse(entry, update)
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

/** 追加日志并在同一事务中更新本地统计投影。 */
export async function appendLog(
  entry: AnyLogEntry,
  analyticsUpdate?: AnalyticsReviewUpdate,
): Promise<number> {
  return db.transaction('rw', ...analyticsTables, async () => {
    const id = await db.logs.add(withoutLocalLogId(entry))
    await projectReviewEntry(entry, analyticsUpdate)
    return id
  })
}

/**
 * 清理本地日志表中的重复条目（历史同步 bug 的遗留污染）。
 *
 * 按 makeDiffKey 保留每个键 id 最小（最先写入）的一条，删除其余副本。
 * 返回删除的条数。数据干净时返回 0。
 */
export async function dedupeLocalLogs(): Promise<number> {
  const seen = new Set<string>()
  const toDelete: number[] = []
  // each 按主键（id）升序遍历，保证每个键首次遇到的是最早写入的副本
  await db.logs.each(entry => {
    const key = makeDiffKey(entry)
    if (seen.has(key)) {
      const id = entry.id
      if (typeof id === 'number') toDelete.push(id)
    } else {
      seen.add(key)
    }
  })
  if (toDelete.length > 0) {
    await db.logs.bulkDelete(toDelete)
  }
  return toDelete.length
}

/** 批量追加日志（如同步导入），并幂等更新统计投影。 */
export async function appendLogs(
  entries: AnyLogEntry[],
  analyticsUpdates: Array<AnalyticsReviewUpdate | undefined> = [],
): Promise<number> {
  if (entries.length === 0) return 0
  return db.transaction('rw', ...analyticsTables, async () => {
    const snapshot = await getLatestSnapshot()
    const children = new Map(snapshot?.state.children.map(child => [child.id, child]) ?? [])
    await db.logs.bulkAdd(entries.map(withoutLocalLogId))
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index]
      let update = analyticsUpdates[index]
      if (!update && entry.type === 'review' && entry.round === 1) {
        const firstReviewDay = children.get(entry.childId)?.progress[entry.character]
          ?.firstReviewDay
        update = { isNew: firstReviewDay === undefined || firstReviewDay === entry.dayKey }
      }
      await projectReviewEntry(entry, update)
    }
    return entries.length
  })
}

export interface AnalyticsBackfillStatus {
  ready: boolean
  processed: number
  total: number
}

interface AnalyticsBackfillCheckpoint extends AnalyticsBackfillStatus {
  lastTimestamp?: number
  lastId?: number
  replayState?: AppState
}

const ANALYTICS_BACKFILL_KEY = 'learningAnalyticsBackfill'
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
  return checkpoint
    ? { ready: checkpoint.ready, processed: checkpoint.processed, total: checkpoint.total }
    : { ready: false, processed: 0, total: 0 }
}

const backfillListeners = new Set<(status: AnalyticsBackfillStatus) => void>()
let backfillPromise: Promise<void> | null = null

/** 按时间戳顺序分批回填统计投影，支持中断后续跑。 */
async function runLearningAnalyticsBackfill(): Promise<void> {
  while (true) {
    const result = (await db.transaction('rw', [...analyticsTables, db.meta], async () => {
      let checkpoint = await db.meta
        .get(ANALYTICS_BACKFILL_KEY)
        .then(row => row?.value as AnalyticsBackfillCheckpoint | undefined)
      if (checkpoint?.ready) {
        if (checkpoint.replayState) {
          const { replayState: _completedReplayState, ...completed } = checkpoint
          await db.meta.put({ key: ANALYTICS_BACKFILL_KEY, value: completed })
          return { status: completed, finished: true }
        }
        return { status: checkpoint, finished: true }
      }
      if (!checkpoint) {
        checkpoint = {
          ready: false,
          processed: 0,
          total: await db.logs.count(),
          replayState: emptyReplayState(),
        }
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
          await projectReviewEntry(row, {
            isNew: previous ? previous.firstReviewDay === row.dayKey : true,
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
        ...(!ready ? { replayState } : {}),
        ...(last ? { lastTimestamp: last.timestamp, lastId: last.id } : {}),
      }
      await db.meta.put({ key: ANALYTICS_BACKFILL_KEY, value: updated })
      return { status: updated, finished: updated.ready }
    })) as { status: AnalyticsBackfillCheckpoint; finished: boolean }
    const status = {
      ready: result.status.ready,
      processed: result.status.processed,
      total: result.status.total,
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

/**
 * Prune the oldest N log entries.
 * Used when the total log count exceeds the threshold (500k).
 * Deletes entries ordered by timestamp ascending.
 */
export async function pruneOldestLogs(count: number): Promise<number> {
  return db.logs.orderBy('timestamp').limit(count).delete()
}

/** Get reviews for a specific child — uses childId index, filterReviews 处理 type */
export async function getReviewsForChild(childId: string): Promise<ReviewEntry[]> {
  return db.logs.where('childId').equals(childId).toArray().then(filterReviews)
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
  // Strip the extra 'type' field before returning as Snapshot
  return { timestamp: result.timestamp, state: result.state }
}

/** Get all historical snapshots, newest first */
export async function getHistoricalSnapshots(): Promise<Snapshot[]> {
  const rows = await db.snapshot.where('type').equals(SNAPSHOT_TYPE_HISTORICAL).sortBy('timestamp')
  // Most recent first
  return rows.reverse().map(r => ({ timestamp: r.timestamp, state: r.state }))
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
