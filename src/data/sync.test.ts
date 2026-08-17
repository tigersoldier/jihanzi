/**
 * @vitest-environment node
 *
 * Tests for sync orchestrator — verifies correct sync behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const {
  mockGetLogsAfter,
  mockGetLatestSnapshot,
  mockLastKnownRemoteTime,
  mockSetLastKnownRemoteTime,
} = vi.hoisted(() => ({
  mockGetLogsAfter: vi.fn(),
  mockGetLatestSnapshot: vi.fn(),
  mockLastKnownRemoteTime: vi.fn().mockResolvedValue(0),
  mockSetLastKnownRemoteTime: vi.fn(),
}))

// ---- Mock drive operations ----
const {
  mockFindOrCreateRootFolder,
  mockFindOrCreateFolder,
  mockFindFile,
  mockPushMeta,
  mockPushSnapshot,
  mockPushLogs,
  mockListFiles,
  mockRepairLogFile,
} = vi.hoisted(() => ({
  mockFindOrCreateRootFolder: vi.fn(),
  mockFindOrCreateFolder: vi.fn(),
  mockFindFile: vi.fn(),
  mockPushMeta: vi.fn(),
  mockPushSnapshot: vi.fn(),
  mockPushLogs: vi.fn(),
  mockListFiles: vi.fn(),
  mockRepairLogFile: vi.fn(),
}))

const { mockHasValidToken } = vi.hoisted(() => ({
  mockHasValidToken: vi.fn().mockReturnValue(true),
}))

const { mockReadFile } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
}))

const { mockPullAllData, mockSaveCurrentSnapshot, mockAppendLogs, mockGetHistoricalSnapshots } =
  vi.hoisted(() => ({
    mockPullAllData: vi.fn(),
    mockSaveCurrentSnapshot: vi.fn(),
    mockAppendLogs: vi.fn(),
    mockGetHistoricalSnapshots: vi.fn().mockResolvedValue([]),
  }))

vi.mock('./drive', () => ({
  findOrCreateRootFolder: (...args: any[]) => mockFindOrCreateRootFolder(...args),
  findOrCreateFolder: (...args: any[]) => mockFindOrCreateFolder(...args),
  findFile: (...args: any[]) => mockFindFile(...args),
  pullAllData: (...args: any[]) => mockPullAllData(...args),
  pushMeta: (...args: any[]) => mockPushMeta(...args),
  pushSnapshot: (...args: any[]) => mockPushSnapshot(...args),
  pushLogs: (...args: any[]) => mockPushLogs(...args),
  listFiles: (...args: any[]) => mockListFiles(...args),
  repairLogFile: (...args: any[]) => mockRepairLogFile(...args),
  readFile: (...args: any[]) => mockReadFile(...args),
  logFileName: (key: string) => `log_${key}.jsonl`,
  snapshotFileName: (key: string) => `snapshot_${key}.json`,
}))

vi.mock('./gapi', () => ({
  hasValidToken: () => mockHasValidToken(),
  getAccessToken: vi.fn(),
  setGapiToken: vi.fn(),
}))

vi.mock('./db', () => ({
  getLogsAfter: (...args: any[]) => mockGetLogsAfter(...args),
  getLatestSnapshot: () => mockGetLatestSnapshot(),
  getLastKnownRemoteTime: () => mockLastKnownRemoteTime(),
  setLastKnownRemoteTime: (...args: any[]) => mockSetLastKnownRemoteTime(...args),
  saveCurrentSnapshot: (...args: any[]) => mockSaveCurrentSnapshot(...args),
  getHistoricalSnapshots: () => mockGetHistoricalSnapshots(),
  appendLog: vi.fn(),
  appendLogs: (...args: any[]) => mockAppendLogs(...args),
  dedupeLocalLogs: vi.fn().mockResolvedValue(0),
}))

const MOCK_LOG_ENTRIES = [
  {
    timestamp: 1001,
    type: 'review',
    childId: 'child_a',
    character: '花',
    grade: 'a',
    round: 1,
    dayKey: '2026-01-01',
  },
  {
    timestamp: 1002,
    type: 'review',
    childId: 'child_b',
    character: '山',
    grade: 'b',
    round: 1,
    dayKey: '2026-01-01',
  },
]

const MOCK_SNAPSHOT = {
  timestamp: 1000,
  state: {
    children: [
      { id: 'child_a', name: '小明', wordBookId: 'wb_1', nextCharIndex: 3, progress: {} },
      { id: 'child_b', name: '小红', wordBookId: 'wb_1', nextCharIndex: 1, progress: {} },
    ],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花', '山', '水'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  },
}

import {
  pushChanges,
  initialPull,
  syncOnce,
  diffEntries,
  isSnapshotPolluted,
  rebuildStateFromLogs,
  verifySnapshotAgainstLogs,
  repairSnapshotProgress,
  repairPollutedData,
} from './sync'

// ============================================================
// diffEntries — content-based log dedup
// ============================================================

describe('diffEntries', () => {
  const entryA = {
    timestamp: 1001,
    type: 'review',
    childId: 'c1',
    character: '花',
    grade: 'a',
    round: 1,
    dayKey: '2026-01-01',
  }
  const entryB = {
    timestamp: 1002,
    type: 'review',
    childId: 'c1',
    character: '山',
    grade: 'b',
    round: 1,
    dayKey: '2026-01-01',
  }
  const entryC = {
    timestamp: 1003,
    type: 'create_child',
    childId: 'c2',
    name: '大明',
    wordBookId: 'wb_1',
  }
  const entryD = {
    timestamp: 1004,
    type: 'create_wordbook',
    wordBookId: 'wb_2',
    name: '新字本',
    characters: ['一', '二'],
  }

  it('finds entries only in remote (remoteOnly)', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA], // local
      [entryA, entryB], // remote
    )
    expect(remoteOnly).toEqual([entryB])
    expect(localOnly).toEqual([])
  })

  it('finds entries only in local (localOnly)', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA, entryB], // local
      [entryA], // remote
    )
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([entryB])
  })

  it('finds both directions when partial overlap', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA, entryB], // local
      [entryA, entryC, entryD], // remote
    )
    expect(remoteOnly).toEqual([entryC, entryD])
    expect(localOnly).toEqual([entryB])
  })

  it('returns empty when collections are identical', () => {
    const { remoteOnly, localOnly } = diffEntries([entryA, entryB], [entryA, entryB])
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([])
  })

  it('returns empty when both are empty', () => {
    const { remoteOnly, localOnly } = diffEntries([], [])
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([])
  })

  it('all local entries are localOnly when remote is empty', () => {
    const { remoteOnly, localOnly } = diffEntries([entryA, entryB, entryC], [])
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([entryA, entryB, entryC])
  })

  it('treats review entries with same timestamp+childId but different characters as different', () => {
    // 同一个孩子在同一毫秒评了两个不同的字 → 应该是两条不同的日志
    const reviewA = {
      timestamp: 1001,
      type: 'review',
      childId: 'c1',
      character: '花',
      grade: 'a',
      round: 1,
      dayKey: '2026-01-01',
    }
    const reviewB = {
      timestamp: 1001,
      type: 'review',
      childId: 'c1',
      character: '山',
      grade: 'b',
      round: 1,
      dayKey: '2026-01-01',
    }

    const { remoteOnly, localOnly } = diffEntries(
      [reviewA], // 本地只有「花」
      [reviewA, reviewB], // 远程有「花」和「山」
    )
    // 「山」在本地不存在 → 应出现在 remoteOnly
    expect(remoteOnly).toEqual([reviewB])
    expect(localOnly).toEqual([])
  })

  it('treats review entries with same timestamp+childId+character as duplicates', () => {
    // 完全相同的复习记录 → 应去重
    const review = {
      timestamp: 1001,
      type: 'review',
      childId: 'c1',
      character: '花',
      grade: 'a',
      round: 1,
      dayKey: '2026-01-01',
    }

    const { remoteOnly, localOnly } = diffEntries([review], [review])
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([])
  })
})

describe('pushChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOrCreateRootFolder.mockResolvedValue('root-folder-id')
    mockFindFile.mockResolvedValue(null)
    mockPushMeta.mockResolvedValue('meta-file-id')
    mockFindOrCreateFolder.mockImplementation((_parentId: string, name: string) =>
      Promise.resolve(`folder-${name}`),
    )
    mockPushSnapshot.mockResolvedValue('snapshot-file-id')
    mockPushLogs.mockResolvedValue('logs-file-id')
  })

  it('pushes app_meta.json to the root folder', async () => {
    await pushChanges(MOCK_LOG_ENTRIES, MOCK_SNAPSHOT as any)

    expect(mockFindOrCreateRootFolder).toHaveBeenCalled()
    expect(mockPushMeta).toHaveBeenCalledWith(
      'root-folder-id',
      expect.objectContaining({ version: '0.1.0', lastKnownRemoteTime: expect.any(Number) }),
      undefined,
    )
  })

  it('creates a subfolder and pushes snapshot + logs for each child', async () => {
    await pushChanges(MOCK_LOG_ENTRIES, MOCK_SNAPSHOT as any)

    expect(mockFindOrCreateFolder).toHaveBeenCalledTimes(2)
    expect(mockFindOrCreateFolder).toHaveBeenCalledWith('root-folder-id', '小明')
    expect(mockFindOrCreateFolder).toHaveBeenCalledWith('root-folder-id', '小红')

    expect(mockPushSnapshot).toHaveBeenCalledTimes(2)
    expect(mockPushLogs).toHaveBeenCalledTimes(2)
  })

  it('does nothing when log entries are empty', async () => {
    await pushChanges([], MOCK_SNAPSHOT as any)

    // Still pushes meta and snapshot
    expect(mockPushMeta).toHaveBeenCalled()
    expect(mockPushSnapshot).toHaveBeenCalledTimes(2)

    // But no logs
    expect(mockPushLogs).not.toHaveBeenCalled()
  })

  it('pushes snapshot to snapshot_current.json', async () => {
    await pushChanges(MOCK_LOG_ENTRIES, MOCK_SNAPSHOT as any)

    const findFileCalls = mockFindFile.mock.calls.filter(
      (c: any[]) => c[1] === 'snapshot_current.json',
    )
    expect(findFileCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('groups log entries by interval key and pushes to separate files', async () => {
    const entry1 = { ...MOCK_LOG_ENTRIES[0], timestamp: new Date('2026-07-03T00:00:00Z').getTime() }
    const entry2 = { ...MOCK_LOG_ENTRIES[1], timestamp: new Date('2026-07-12T00:00:00Z').getTime() }

    await pushChanges([entry1, entry2] as any, MOCK_SNAPSHOT as any)

    const logFileNames = mockPushLogs.mock.calls.map((c: any[]) => c[3])
    const uniqueFiles = new Set(logFileNames)
    expect(uniqueFiles.size).toBe(2) // 2 distinct interval filenames
  })

  it('pushes historical snapshots that do not exist on Drive yet', async () => {
    mockGetHistoricalSnapshots.mockResolvedValue([
      { timestamp: new Date('2026-06-21T00:00:00Z').getTime(), state: MOCK_SNAPSHOT.state },
    ])
    mockFindFile.mockResolvedValue(null)

    await pushChanges(MOCK_LOG_ENTRIES, MOCK_SNAPSHOT as any)

    const histPushCalls = mockPushSnapshot.mock.calls.filter(
      (c: any[]) => c[3] === 'snapshot_2026-06-21.json',
    )
    expect(histPushCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('skips historical snapshots that already exist on Drive', async () => {
    mockGetHistoricalSnapshots.mockResolvedValue([
      { timestamp: new Date('2026-06-21T00:00:00Z').getTime(), state: MOCK_SNAPSHOT.state },
    ])
    mockFindFile.mockResolvedValue({ id: 'existing-hist-id', modifiedTime: '2026-06-21T00:00:00Z' })

    await pushChanges(MOCK_LOG_ENTRIES, MOCK_SNAPSHOT as any)

    const histPushCalls = mockPushSnapshot.mock.calls.filter(
      (c: any[]) => c[3] === 'snapshot_2026-06-21.json',
    )
    expect(histPushCalls.length).toBe(0)
  })

  it('strips auto-increment id from log entries before pushing to Drive', async () => {
    // 模拟 IndexedDB 返回的条目带有自增 id
    const entriesWithId = MOCK_LOG_ENTRIES.map((e, i) => ({ ...e, id: i + 1 }))
    await pushChanges(entriesWithId as any, MOCK_SNAPSHOT as any)

    // pushLogs 的第二个参数是 logLines（字符串数组）
    const pushLogsCalls = mockPushLogs.mock.calls
    for (const call of pushLogsCalls) {
      const lines: string[] = call[1]
      for (const line of lines) {
        const parsed = JSON.parse(line)
        // id 字段不应出现在 Drive 条目中
        expect(parsed).not.toHaveProperty('id')
      }
    }
  })
})

// ---- initialPull -------------------------------------------------------

const MOCK_REMOTE_SNAPSHOT = {
  timestamp: 2000,
  state: {
    children: [{ id: 'child_x', name: '小明', wordBookId: 'wb_1', nextCharIndex: 5, progress: {} }],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二', '三', '四', '五'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  },
}

const MOCK_REMOTE_LOG_LINES = [
  '{"timestamp":2001,"type":"create_child","childId":"child_x","name":"小明","wordBookId":"wb_1","id":1}',
  '{"timestamp":2002,"type":"create_wordbook","wordBookId":"wb_1","name":"生字本","characters":["一","二","三","四","五"],"id":2}',
]

const MOCK_REMOTE_CHILD_DATA = {
  小明: {
    snapshot: JSON.stringify(MOCK_REMOTE_SNAPSHOT),
    logs: MOCK_REMOTE_LOG_LINES,
  },
}

describe('initialPull', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasValidToken.mockReturnValue(true)
    mockGetLatestSnapshot.mockResolvedValue(null)
    mockGetLogsAfter.mockResolvedValue([])
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: MOCK_REMOTE_CHILD_DATA,
    })
  })

  // ---- Tracer bullet: data from Drive is saved to local IndexedDB ----

  it('saves pulled snapshot and log entries to IndexedDB', async () => {
    await initialPull()

    // Snapshot saved
    expect(mockSaveCurrentSnapshot).toHaveBeenCalledTimes(1)
    expect(mockSaveCurrentSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        timestamp: MOCK_REMOTE_SNAPSHOT.timestamp,
        state: expect.objectContaining({
          children: expect.arrayContaining([
            expect.objectContaining({ id: 'child_x', name: '小明' }),
          ]),
        }),
      }),
    )

    // Log entries saved
    expect(mockAppendLogs).toHaveBeenCalledTimes(1)
    const appendedLogs = mockAppendLogs.mock.calls[0][0] as any[]
    expect(appendedLogs.length).toBe(2)
    expect(appendedLogs[0]).toMatchObject({ timestamp: 2001, type: 'create_child' })
    expect(appendedLogs[1]).toMatchObject({ timestamp: 2002, type: 'create_wordbook' })
  })

  // ---- Edge: empty Drive (no child folders) ----

  it('does nothing when Drive has no data', async () => {
    mockPullAllData.mockResolvedValue({
      meta: null,
      childData: {},
    })

    await initialPull()

    expect(mockSaveCurrentSnapshot).not.toHaveBeenCalled()
    expect(mockAppendLogs).not.toHaveBeenCalled()
  })

  // ---- Edge: invalid token skips pull entirely ----

  it('skips pull when token is invalid', async () => {
    mockHasValidToken.mockReturnValue(false)

    await initialPull()

    expect(mockPullAllData).not.toHaveBeenCalled()
  })

  // ---- Merge: filters by snapshot timestamp ----

  it('only appends log entries with timestamp > local snapshot timestamp', async () => {
    // Local snapshot at timestamp 2000 — remote entries before this are skipped
    mockGetLatestSnapshot.mockResolvedValue({
      timestamp: 2000,
      state: {
        children: [],
        wordBooks: [],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    })

    await initialPull()

    // Both remote entries have timestamp 2001,2002 > 2000 → both appended
    expect(mockAppendLogs).toHaveBeenCalledTimes(1)
    const appendedLogs = mockAppendLogs.mock.calls[0][0] as any[]
    expect(appendedLogs.length).toBe(2)
  })

  // ---- Data integrity: remote id fields must be stripped before insert ----

  it('strips auto-increment id from remote entries before saving to IndexedDB', async () => {
    await initialPull()

    expect(mockAppendLogs).toHaveBeenCalledTimes(1)
    const appendedLogs = mockAppendLogs.mock.calls[0][0] as Record<string, unknown>[]
    for (const entry of appendedLogs) {
      // Auto-increment id must NOT be present — Dexie would try to use it
      // as the primary key, causing ConstraintError on duplicate.
      expect(entry).not.toHaveProperty('id')
    }
  })

  // ---- Materialize: remote review logs are replayed into snapshot ----

  it('replays remote review entries into snapshot after merge (first import)', async () => {
    // 模拟首次导入场景：远程 snapshot 的 progress 为空，但远程日志包含复习记录
    const remoteLogLinesWithReviews = [
      ...MOCK_REMOTE_LOG_LINES,
      '{"timestamp":2003,"type":"review","childId":"child_x","character":"一","grade":"a","round":1,"dayKey":"2026-07-01"}',
      '{"timestamp":2004,"type":"review","childId":"child_x","character":"二","grade":"b","round":1,"dayKey":"2026-07-01"}',
      '{"timestamp":2005,"type":"review","childId":"child_x","character":"三","grade":"c","round":1,"dayKey":"2026-07-02"}',
    ]
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify(MOCK_REMOTE_SNAPSHOT),
          logs: remoteLogLinesWithReviews,
        },
      },
    })

    await initialPull()

    // 验证 saveCurrentSnapshot 被调用时，state 包含物化后的 progress
    expect(mockSaveCurrentSnapshot).toHaveBeenCalled()
    const savedSnapshot =
      mockSaveCurrentSnapshot.mock.calls[mockSaveCurrentSnapshot.mock.calls.length - 1][0]
    const savedChild = savedSnapshot.state.children[0]
    expect(savedChild.progress['一']).toBeDefined()
    expect(savedChild.progress['一'].lastGrade).toBe('a')
    expect(savedChild.progress['一'].firstReviewDay).toBe('2026-07-01')
    expect(savedChild.progress['二']).toBeDefined()
    expect(savedChild.progress['二'].lastGrade).toBe('b')
    expect(savedChild.progress['三']).toBeDefined()
    expect(savedChild.progress['三'].lastGrade).toBe('c')
  })

  it('全新浏览器全量拉取时不重复重放快照已物化的日志（回归：途 3 次不被算成 6 次）', async () => {
    // 真实场景：Drive 上的 snapshot_current.json 是完整状态（增量物化），
    // progress 已包含全部远程日志的效果。全新浏览器本地为空 → remoteOnly
    // = 全部远程日志；若全部重放到完整快照上，同一复习被应用两次：
    // 途 3→6 次、interval 22→595 天（与导入 bug 相同）。
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify({
            timestamp: 1785564867246,
            state: {
              children: [
                {
                  id: 'child_1',
                  name: '小明',
                  wordBookId: 'wb_1',
                  nextCharIndex: 2,
                  progress: {
                    途: {
                      ease: 2.8,
                      interval: 22,
                      repetitions: 3,
                      nextReview: '2026-08-18',
                      lastGrade: 'a',
                      firstReviewDay: '2026-07-08',
                    },
                  },
                },
              ],
              wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '途'] }],
              settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
            },
          }),
          logs: [
            '{"timestamp":1783566656274,"type":"review","childId":"child_1","character":"途","grade":"a","round":1,"dayKey":"2026-07-08"}',
            '{"timestamp":1783616286291,"type":"review","childId":"child_1","character":"途","grade":"a","round":1,"dayKey":"2026-07-09"}',
            '{"timestamp":1785205079007,"type":"review","childId":"child_1","character":"途","grade":"a","round":1,"dayKey":"2026-07-27"}',
          ],
        },
      },
    })

    await initialPull()

    const savedSnapshot = mockSaveCurrentSnapshot.mock.calls.at(-1)[0]
    const savedChild = savedSnapshot.state.children[0]
    // 快照已物化的复习不重复应用：途保持 3 次、interval 22（而非 6 次、595 天）
    expect(savedChild.progress['途']).toMatchObject({ ease: 2.8, interval: 22, repetitions: 3 })
  })

  it('采纳无 appliedThrough 的旧版快照时逐字校验修复（中度污染）', async () => {
    // 真实事故模式：今 3 条日志被旧代码应用 3 次 → reps 9 / interval 21362。
    // 廉价阈值不拦截（interval < 36500、ease < 5、日期合法），逐字校验必须兑住。
    const jinLogs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_1',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-18',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_1',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-19',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_1',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-04',
      },
    ]
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify({
            timestamp: 1000,
            state: {
              children: [
                {
                  id: 'child_1',
                  name: '小明',
                  wordBookId: 'wb_1',
                  nextCharIndex: 1,
                  progress: {
                    今: {
                      ease: 3.4,
                      interval: 21362,
                      repetitions: 9,
                      nextReview: '2085-01-28',
                      lastGrade: 'a',
                      firstReviewDay: '2026-05-18',
                    },
                  },
                },
              ],
              wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['今'] }],
              settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
            },
          }),
          logs: jinLogs.map(l => JSON.stringify(l)),
        },
      },
    })
    mockGetLogsAfter.mockResolvedValue(jinLogs)

    await initialPull()

    const saved = mockSaveCurrentSnapshot.mock.calls.at(-1)[0]
    expect(saved.state.children[0].progress['今']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
    })
    // 修复后写入水位（P3 标记）：max(快照墙钟 1000, 并集最大 ts 300)
    expect(saved.appliedThrough).toBe(1000)
  })

  it('有 appliedThrough 的 P3 快照直接信任，不逐字校验', async () => {
    // 远程快照带水位（P3 产物）→ 不做逐字校验；只重放水位之后的条目
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify({
            timestamp: 10_000_000,
            appliedThrough: 10_500_000,
            state: {
              children: [
                {
                  id: 'child_1',
                  name: '小明',
                  wordBookId: 'wb_1',
                  nextCharIndex: 1,
                  progress: {
                    今: {
                      ease: 2.7,
                      interval: 8,
                      repetitions: 2,
                      nextReview: '2026-08-12',
                      lastGrade: 'a',
                      firstReviewDay: '2026-05-18',
                    },
                  },
                },
              ],
              wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['今', '二'] }],
              settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
            },
          }),
          logs: [
            '{"timestamp":10501000,"type":"review","childId":"child_1","character":"二","grade":"a","round":1,"dayKey":"2026-08-06"}',
          ],
        },
      },
    })
    mockGetLogsAfter.mockResolvedValue([])

    await initialPull()

    const saved = mockSaveCurrentSnapshot.mock.calls.at(-1)[0]
    // 水位之后的条目被重放（新字「二」物化）
    expect(saved.state.children[0].progress['二']).toBeDefined()
    // 水位之内的「今」不被重复应用
    expect(saved.state.children[0].progress['今'].repetitions).toBe(2)
    // 水位推进到重放条目的最大 timestamp
    expect(saved.appliedThrough).toBe(10501000)
    // 未触发逐字校验（校验会以 0 为下界拉全量日志）
    expect(mockGetLogsAfter).not.toHaveBeenCalledWith(0)
  })

  it('replays remote review entries into snapshot after merge (incremental)', async () => {
    // 模拟增量同步场景：本地已有 snapshot（含部分 progress），
    // 远程拉取到新的复习日志
    const localSnapshot = {
      timestamp: 3000,
      state: {
        children: [
          // 本地已学了「一」和「二」；「三」尚未学
          {
            id: 'child_x',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 2,
            progress: {
              一: {
                ease: 2.5,
                interval: 1,
                repetitions: 1,
                nextReview: '2026-07-02',
                lastGrade: 'a',
                firstReviewDay: '2026-07-01',
              },
              二: {
                ease: 2.5,
                interval: 1,
                repetitions: 1,
                nextReview: '2026-07-02',
                lastGrade: 'b',
                firstReviewDay: '2026-07-01',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二', '三', '四', '五'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    mockGetLatestSnapshot.mockResolvedValue(localSnapshot)

    // 远程新日志：设备 B 上学了「三」（时间戳晚于本地快照 3000）
    const remoteLogLinesWithNewReview = [
      '{"timestamp":3001,"type":"review","childId":"child_x","character":"三","grade":"a","round":1,"dayKey":"2026-07-03"}',
    ]
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: null, // 远程 snapshot 可能不存在或更旧
          logs: remoteLogLinesWithNewReview,
        },
      },
    })

    await initialPull()

    // 验证 saveCurrentSnapshot 被调用来物化远程复习数据
    expect(mockSaveCurrentSnapshot).toHaveBeenCalled()
    const savedSnapshot =
      mockSaveCurrentSnapshot.mock.calls[mockSaveCurrentSnapshot.mock.calls.length - 1][0]
    const savedChild = savedSnapshot.state.children[0]
    // 原有的 progress 保留
    expect(savedChild.progress['一']).toBeDefined()
    expect(savedChild.progress['二']).toBeDefined()
    // 远程复习也被物化
    expect(savedChild.progress['三']).toBeDefined()
    expect(savedChild.progress['三'].lastGrade).toBe('a')
    expect(savedChild.progress['三'].firstReviewDay).toBe('2026-07-03')
  })

  it('does not overwrite snapshot when remote has no review logs', async () => {
    // 远程只有 create_child/create_wordbook 类日志，没有复习
    // snapshot 已由初始保存阶段处理，不应二次重写
    const localSnapshot = {
      timestamp: 3000,
      state: {
        children: [
          {
            id: 'child_y',
            name: '小红',
            wordBookId: 'wb_2',
            nextCharIndex: 3,
            progress: {
              山: {
                ease: 2.5,
                interval: 3,
                repetitions: 3,
                nextReview: '2026-07-04',
                lastGrade: 'a',
                firstReviewDay: '2026-07-01',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_2', name: '另一个生字本', characters: ['山', '水', '火'] }],
        settings: { dailyReviewLimit: 20, dailyNewChars: 3, maxRounds: 3 },
      },
    }
    mockGetLatestSnapshot.mockResolvedValue(localSnapshot)

    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify(MOCK_REMOTE_SNAPSHOT),
          logs: MOCK_REMOTE_LOG_LINES,
        },
      },
    })

    await initialPull()

    // 远程 snapshot 时间戳 2000 < 本地 3000，不应覆盖
    const saveCalls = mockSaveCurrentSnapshot.mock.calls
    const overwriteCall = saveCalls.find(
      (call: any[]) => call[0]?.timestamp === MOCK_REMOTE_SNAPSHOT.timestamp,
    )
    expect(overwriteCall).toBeUndefined()

    // appendLogs 可能被调用（远程 log 匹配了新 child），但 snapshot 不应被错误覆盖
    // 本地 snapshot 的 progress 不应丢失
  })

  // ---- Merge: keeps local snapshot when it is newer than remote ----

  it('keeps local snapshot when it is newer than remote', async () => {
    const newerLocalSnapshot = {
      timestamp: 3000,
      state: {
        children: [
          { id: 'child_y', name: '小红', wordBookId: 'wb_2', nextCharIndex: 3, progress: {} },
        ],
        wordBooks: [{ id: 'wb_2', name: '另一个生字本', characters: ['山', '水', '火'] }],
        settings: { dailyReviewLimit: 20, dailyNewChars: 3, maxRounds: 3 },
      },
    }
    mockGetLatestSnapshot.mockResolvedValue(newerLocalSnapshot)

    await initialPull()

    // Should NOT overwrite the newer local snapshot with the older remote one
    const saveCalls = mockSaveCurrentSnapshot.mock.calls
    const overwriteCall = saveCalls.find(
      (call: any[]) => call[0]?.timestamp === MOCK_REMOTE_SNAPSHOT.timestamp,
    )
    expect(overwriteCall).toBeUndefined()
  })

  // ---- Incremental pull: passes lastKnownRemoteTime to pullAllData ----

  it('passes modifiedAfter to pullAllData when lastKnownRemoteTime > 0', async () => {
    await initialPull(1700000000000)

    // pullAllData 应收到 ISO 字符串参数
    expect(mockPullAllData).toHaveBeenCalledWith('2023-11-14T22:13:20.000Z')
  })

  it('does not pass modifiedAfter when lastKnownRemoteTime is 0 (first sync)', async () => {
    await initialPull(0)

    // pullAllData 不传参数 → 全量拉取
    expect(mockPullAllData).toHaveBeenCalledWith(undefined)
  })

  it('does not pass modifiedAfter when lastKnownRemoteTime is undefined', async () => {
    await initialPull(undefined)

    expect(mockPullAllData).toHaveBeenCalledWith(undefined)
  })

  // ---- Internal dedup: remoteOnly entries are deduplicated before appendLogs ----

  it('deduplicates remoteOnly by diff key before appending to IndexedDB', async () => {
    // remote 包含两条 key 完全相同的条目（模拟 Drive 文件已有重复行）
    const dupLogLines = [
      '{"timestamp":2001,"type":"create_child","childId":"child_x","name":"小明","wordBookId":"wb_1"}',
      '{"timestamp":2001,"type":"create_child","childId":"child_x","name":"小明","wordBookId":"wb_1"}',
    ]
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify(MOCK_REMOTE_SNAPSHOT),
          logs: dupLogLines,
        },
      },
    })
    // 本地没有对应条目 → 两条都进 remoteOnly → 应该去重
    mockGetLogsAfter.mockResolvedValue([])

    await initialPull()

    expect(mockAppendLogs).toHaveBeenCalledTimes(1)
    const appended = mockAppendLogs.mock.calls[0][0] as any[]
    expect(appended).toHaveLength(1)
  })

  // ---- Candidate window: uses remoteTMin, not snapshot timestamp ----

  it('computes candidate window from remote batch minimum timestamp', async () => {
    const wideRangeLogLines = [
      // 时间跨度很大：最早 1000，最晚 5000
      '{"timestamp":1000,"type":"review","childId":"child_x","character":"一","grade":"a","round":1,"dayKey":"2026-01-01"}',
      '{"timestamp":5000,"type":"review","childId":"child_x","character":"二","grade":"b","round":1,"dayKey":"2026-01-02"}',
    ]
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify({ ...MOCK_REMOTE_SNAPSHOT, timestamp: 6000 }),
          logs: wideRangeLogLines,
        },
      },
    })
    mockGetLatestSnapshot.mockResolvedValue({
      timestamp: 6000, // 本地快照时间戳很新
      state: MOCK_SNAPSHOT.state,
    })

    await initialPull()

    // getLogsAfter 应以 remoteTMin(1000) - CLOCK_SKEW_BUFFER 为下限，
    // 而非 snapshot.timestamp(6000) - CLOCK_SKEW_BUFFER
    const queryStart = mockGetLogsAfter.mock.calls[0][0] as number
    // CLOCK_SKEW_BUFFER = 1小时 = 3600000ms, 1000 - 3600000 = -3599000 → max(0, ...) = 0
    expect(queryStart).toBe(0)
  })

  // ---- Incremental pull: driveIsEmpty must be false when child folders exist ----

  it('reports driveIsEmpty=false when child folders exist but no files match modifiedAfter filter', async () => {
    // 模拟增量同步场景：Drive 上有子文件夹，但因 modifiedAfter 过滤没有匹配的文件
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: null, // 快照文件不在过滤范围内
          historicalSnapshots: [],
          logs: [], // 日志文件不在过滤范围内
        },
      },
    })

    const result = await initialPull(1700000000000) // 传入非零的 lastKnownRemoteTime

    // 关键断言：Drive 非空（有子文件夹），只是没有最近变更的文件
    expect(result.driveIsEmpty).toBe(false)
  })

  it('reports driveIsEmpty=true when no child folders and no modifiedAfter (true first sync)', async () => {
    mockPullAllData.mockResolvedValue({
      meta: null,
      childData: {},
    })

    const result = await initialPull(0)

    expect(result.driveIsEmpty).toBe(true)
  })
})

// ---- syncOnce ------------------------------------------------------------

describe('syncOnce', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasValidToken.mockReturnValue(true)
    mockLastKnownRemoteTime.mockResolvedValue(1700000000000) // 非零 → 已有同步记录
    mockGetLatestSnapshot.mockResolvedValue(MOCK_SNAPSHOT as any)
    mockGetLogsAfter.mockResolvedValue(MOCK_LOG_ENTRIES)
    // 模拟 Drive 有子文件夹但无最近变更的文件
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: { snapshot: null, historicalSnapshots: [], logs: [] },
      },
    })
    mockFindOrCreateRootFolder.mockResolvedValue('root-id')
    mockFindOrCreateFolder.mockResolvedValue('folder-id')
    mockFindFile.mockResolvedValue(null)
    mockPushMeta.mockResolvedValue('meta-id')
    mockPushSnapshot.mockResolvedValue('snap-id')
    mockPushLogs.mockResolvedValue('log-id')
    mockGetHistoricalSnapshots.mockResolvedValue([])
  })

  it('uses lastKnownRemoteTime as candidate window lower bound when no remote changes', async () => {
    // 远程无最近变更 → remoteLogEntries 为空 → candidate window 应以 lastKnownRemoteTime 为基准
    await syncOnce()

    // getLogsAfter 应收到 lastKnownRemoteTime - CLOCK_SKEW_BUFFER 作为下限
    const queryStart = mockGetLogsAfter.mock.calls[0][0] as number
    // CLOCK_SKEW_BUFFER = 3600000, lastKnownRemoteTime = 1700000000000
    expect(queryStart).toBe(1700000000000 - 3600000)
  })

  it('does not push when no local-only entries found', async () => {
    // 本地候选条目为空 → 不应 push
    mockGetLogsAfter.mockResolvedValue([])

    await syncOnce()

    // pushLogs 不应被调用
    expect(mockPushLogs).not.toHaveBeenCalled()
  })
})

// ============================================================
// isSnapshotPolluted — SM-2 状态污染检测
// ============================================================

describe('isSnapshotPolluted', () => {
  const cleanState = {
    children: [
      {
        id: 'child_a',
        name: '小明',
        wordBookId: 'wb_1',
        nextCharIndex: 2,
        progress: {
          花: {
            ease: 2.6,
            interval: 3,
            repetitions: 1,
            nextReview: '2026-07-04',
            lastGrade: 'a',
            firstReviewDay: '2026-07-01',
          },
        },
      },
    ],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花', '山'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  }

  it('正常快照不被判定为污染', () => {
    expect(isSnapshotPolluted(cleanState)).toBe(false)
  })

  it('interval 超过上限（重复应用导致指数爆炸）判定为污染', () => {
    const polluted = JSON.parse(JSON.stringify(cleanState))
    polluted.children[0].progress['花'].interval = 1.79e28
    expect(isSnapshotPolluted(polluted)).toBe(true)
  })

  it('interval 恰好等于上限（重复应用被封顶）也判定为污染', () => {
    // 真实事故数据：MAX_SANE_INTERVAL_DAYS 封顶后 interval === 36500，
    // 旧版 '>' 比较恰好漏检——封顶值本身就是重复应用的证据
    const polluted = JSON.parse(JSON.stringify(cleanState))
    polluted.children[0].progress['花'].interval = 36500
    expect(isSnapshotPolluted(polluted)).toBe(true)
  })

  it('nextReview 为 NaN-NaN-NaN（日期溢出）判定为污染', () => {
    const polluted = JSON.parse(JSON.stringify(cleanState))
    polluted.children[0].progress['花'].nextReview = 'NaN-NaN-NaN'
    expect(isSnapshotPolluted(polluted)).toBe(true)
  })

  it('ease 异常偏高（重复应用 25+ 次）判定为污染', () => {
    const polluted = JSON.parse(JSON.stringify(cleanState))
    polluted.children[0].progress['花'].ease = 6.8
    expect(isSnapshotPolluted(polluted)).toBe(true)
  })

  it('无 progress 的快照不被判定为污染', () => {
    const empty = JSON.parse(JSON.stringify(cleanState))
    empty.children[0].progress = {}
    expect(isSnapshotPolluted(empty)).toBe(false)
  })
})

// ============================================================
// rebuildStateFromLogs — 从去重日志重建学习进度
// ============================================================

describe('rebuildStateFromLogs', () => {
  const pollutedState = {
    children: [
      {
        id: 'child_a',
        name: '小明',
        wordBookId: 'wb_1',
        // 污染的 nextCharIndex 和 progress
        nextCharIndex: 100,
        progress: {
          花: {
            ease: 6.8,
            interval: 1.79e28,
            repetitions: 43,
            nextReview: 'NaN-NaN-NaN',
            lastGrade: 'a',
            firstReviewDay: '2026-05-30',
          },
        },
      },
    ],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花', '山', '水'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  }

  // 真实污染模式：同一条 review 被同步重复追加 14 次
  const reviewOnce = {
    timestamp: 100,
    type: 'review',
    childId: 'child_a',
    character: '花',
    grade: 'a',
    round: 1,
    dayKey: '2026-07-01',
  }
  const reviewTwice = {
    timestamp: 200,
    type: 'review',
    childId: 'child_a',
    character: '山',
    grade: 'b',
    round: 1,
    dayKey: '2026-07-01',
  }
  const duplicatedLog = [...Array(14).fill(reviewOnce), ...Array(14).fill(reviewTwice)]

  it('重建后 interval/ease 恢复为去重日志的正确值，结构与 nextCharIndex 保留', () => {
    const rebuilt = rebuildStateFromLogs(pollutedState, duplicatedLog)

    const child = rebuilt.children[0]
    // 结构保留
    expect(child.name).toBe('小明')
    expect(rebuilt.wordBooks[0].characters).toEqual(['花', '山', '水'])
    // progress 恢复正确（花：1 次 a → interval 3；山：1 次 b → q=3 → ease 2.36 → interval 2）
    expect(child.progress['花']).toMatchObject({ ease: 2.6, interval: 3, repetitions: 1 })
    expect(child.progress['山']).toMatchObject({ ease: 2.36, interval: 2, repetitions: 1 })
    // nextCharIndex 从日志重建（花、山都是首次复习 → 指针越过山）
    expect(child.nextCharIndex).toBe(2)
    // 污染字符被清除
    expect(child.progress['花'].nextReview).not.toBe('NaN-NaN-NaN')
  })

  it('空日志重建为空 progress 且 nextCharIndex 归零', () => {
    const rebuilt = rebuildStateFromLogs(pollutedState, [])
    const child = rebuilt.children[0]
    expect(child.progress).toEqual({})
    expect(child.nextCharIndex).toBe(0)
  })

  it('不修改传入的状态（纯函数）', () => {
    const original = JSON.stringify(pollutedState)
    rebuildStateFromLogs(pollutedState, duplicatedLog)
    expect(JSON.stringify(pollutedState)).toBe(original)
  })
})

// ============================================================
// verifySnapshotAgainstLogs / repairSnapshotProgress — 逐字核对与修复
// ============================================================

describe('verifySnapshotAgainstLogs', () => {
  const baseStructure = {
    children: [
      {
        id: 'child_a',
        name: '小明',
        wordBookId: 'wb_1',
        nextCharIndex: 3,
        progress: {} as Record<string, unknown>,
      },
    ],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['今', '住', '及', '伏'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  }

  const makeState = (progress: Record<string, unknown>) => ({
    ...baseStructure,
    children: [
      {
        ...baseStructure.children[0],
        progress,
      },
    ],
  })

  // 真实事故数据：同一复习被重复应用 3 次（今：3 条日志 → reps 9）
  const pollutedJin = {
    ease: 3.4,
    interval: 21362,
    repetitions: 9,
    nextReview: '2085-01-28',
    lastGrade: 'a',
    firstReviewDay: '2026-05-18',
  }
  const jinLogs = [
    {
      timestamp: 100,
      type: 'review',
      childId: 'child_a',
      character: '今',
      grade: 'a',
      round: 1,
      dayKey: '2026-05-18',
    },
    {
      timestamp: 200,
      type: 'review',
      childId: 'child_a',
      character: '今',
      grade: 'a',
      round: 1,
      dayKey: '2026-05-19',
    },
    {
      timestamp: 300,
      type: 'review',
      childId: 'child_a',
      character: '今',
      grade: 'a',
      round: 1,
      dayKey: '2026-08-04',
    },
  ]

  it('×3 污染（interval 21362、日期合法、ease 3.4）被检出——旧阈值检测漏掉的中度污染', () => {
    const result = verifySnapshotAgainstLogs(makeState({ 今: pollutedJin }), jinLogs)
    expect(result.polluted).toBe(true)
    expect(result.mismatches).toEqual([{ childId: 'child_a', character: '今' }])
  })

  it('interval 恰好等于 36500 封顶的污染被检出', () => {
    // 重复应用被 MAX_SANE_INTERVAL_DAYS 封顶后，interval 不再 > 上限，
    // 旧检测（>）漏检——逐字核对必须兜住
    const capped = {
      ease: 3.28,
      interval: 36500,
      repetitions: 15,
      nextReview: '2126-06-05',
      lastGrade: 'a',
      firstReviewDay: '2026-04-20',
    }
    const zhuLogs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '住',
        grade: 'a',
        round: 1,
        dayKey: '2026-04-20',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '住',
        grade: 'a',
        round: 1,
        dayKey: '2026-04-21',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '住',
        grade: 'a',
        round: 1,
        dayKey: '2026-06-21',
      },
      {
        timestamp: 400,
        type: 'review',
        childId: 'child_a',
        character: '住',
        grade: 'a',
        round: 1,
        dayKey: '2026-06-22',
      },
      {
        timestamp: 500,
        type: 'review',
        childId: 'child_a',
        character: '住',
        grade: 'b',
        round: 1,
        dayKey: '2026-06-29',
      },
    ]
    const result = verifySnapshotAgainstLogs(makeState({ 住: capped }), zhuLogs)
    expect(result.polluted).toBe(true)
  })

  it('历史不完整的字（日志缺早期复习）不参与核对，不误报', () => {
    // 伏：快照 firstReviewDay 03-05，但日志只剩 07-08 起——重放首日更晚
    const fu = {
      ease: 3.0,
      interval: 595,
      repetitions: 6,
      nextReview: '2028-01-14',
      lastGrade: 'a',
      firstReviewDay: '2026-03-05',
    }
    const fuLogs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '伏',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-08',
      },
    ]
    const result = verifySnapshotAgainstLogs(makeState({ 伏: fu }), fuLogs)
    expect(result.polluted).toBe(false)
  })

  it('快照缺失早期应用（日志首日更早）也检出——重放有更全的历史', () => {
    // 真实事故：弯 08-04 的复习从未应用到快照，快照首日被记为 08-05
    const wan = {
      ease: 2.8,
      interval: 22,
      repetitions: 3,
      nextReview: '2026-09-04',
      lastGrade: 'a',
      firstReviewDay: '2026-08-05',
    }
    const wanLogs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '弯',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-04',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '弯',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-05',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '弯',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-13',
      },
    ]
    const result = verifySnapshotAgainstLogs(makeState({ 弯: wan }), wanLogs)
    expect(result.polluted).toBe(true)
    expect(result.mismatches).toEqual([{ childId: 'child_a', character: '弯' }])
  })

  it('一致快照判为干净', () => {
    // 守卫重放的正确值：05-18 应用、05-19 跳过、08-04 应用
    const cleanJin = {
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
      lastGrade: 'a',
      firstReviewDay: '2026-05-18',
    }
    const result = verifySnapshotAgainstLogs(makeState({ 今: cleanJin }), jinLogs)
    expect(result.polluted).toBe(false)
    expect(result.mismatches).toEqual([])
  })
})

describe('repairSnapshotProgress', () => {
  const baseStructure = {
    children: [
      {
        id: 'child_a',
        name: '小明',
        wordBookId: 'wb_1',
        nextCharIndex: 3,
        progress: {} as Record<string, unknown>,
      },
    ],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['今', '住', '及', '伏'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  }

  const makeState = (progress: Record<string, unknown>) => ({
    ...baseStructure,
    children: [{ ...baseStructure.children[0], progress }],
  })

  it('×3 污染字被替换为重放值（今 → reps 2 / interval 8）', () => {
    const state = makeState({
      今: {
        ease: 3.4,
        interval: 21362,
        repetitions: 9,
        nextReview: '2085-01-28',
        lastGrade: 'a',
        firstReviewDay: '2026-05-18',
      },
    })
    const logs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-18',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-19',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-04',
      },
    ]

    const { state: repaired, repaired: list } = repairSnapshotProgress(state, logs)

    expect(list).toEqual(['今'])
    expect(repaired.children[0].progress['今']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
      lastGrade: 'a',
      firstReviewDay: '2026-05-18',
    })
    // 输入状态不被修改（纯函数）
    expect(state.children[0].progress['今'].repetitions).toBe(9)
  })

  it('缺失应用的字被修复（及：08-04 的 d 从未被应用 → reps 0 / interval 1）', () => {
    const state = makeState({
      及: {
        ease: 3.1,
        interval: 595,
        repetitions: 6,
        nextReview: '2028-01-14',
        lastGrade: 'a',
        firstReviewDay: '2026-05-28',
      },
    })
    const logs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '及',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-28',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '及',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-29',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '及',
        grade: 'd',
        round: 1,
        dayKey: '2026-08-04',
      },
    ]

    const { state: repaired, repaired: list } = repairSnapshotProgress(state, logs)

    expect(list).toEqual(['及'])
    expect(repaired.children[0].progress['及']).toMatchObject({
      ease: 2.5,
      interval: 1,
      repetitions: 0,
      nextReview: '2026-08-05',
      lastGrade: 'd',
      firstReviewDay: '2026-05-28',
    })
  })

  it('快照缺失早期应用的字被修复（弯：日志首日 08-04 早于快照首日 08-05）', () => {
    const state = makeState({
      弯: {
        ease: 2.8,
        interval: 22,
        repetitions: 3,
        nextReview: '2026-09-04',
        lastGrade: 'a',
        firstReviewDay: '2026-08-05',
      },
    })
    const logs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '弯',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-04',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '弯',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-05',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '弯',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-13',
      },
    ]

    const { state: repaired, repaired: list } = repairSnapshotProgress(state, logs)

    expect(list).toEqual(['弯'])
    expect(repaired.children[0].progress['弯']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-21',
      firstReviewDay: '2026-08-04',
    })
  })

  it('历史不完整的字保持原样，不被误改', () => {
    const fuValue = {
      ease: 3.0,
      interval: 595,
      repetitions: 6,
      nextReview: '2028-01-14',
      lastGrade: 'a',
      firstReviewDay: '2026-03-05',
    }
    const state = makeState({ 伏: fuValue })
    const logs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '伏',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-08',
      },
    ]

    const { state: repaired, repaired: list } = repairSnapshotProgress(state, logs)

    expect(list).toEqual([])
    expect(repaired.children[0].progress['伏']).toEqual(fuValue)
  })

  it('一致快照零修改', () => {
    const clean = {
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
      lastGrade: 'a',
      firstReviewDay: '2026-05-18',
    }
    const state = makeState({ 今: clean })
    const logs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-18',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-19',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-04',
      },
    ]

    const { repaired: list } = repairSnapshotProgress(state, logs)
    expect(list).toEqual([])
  })

  it('nextCharIndex 取 max：重放低估时不回退指针', () => {
    const state = makeState({})
    state.children[0].nextCharIndex = 350
    const logs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-18',
      },
    ]

    const { state: repaired } = repairSnapshotProgress(state, logs)
    expect(repaired.children[0].nextCharIndex).toBe(350)
  })
})

describe('pushChanges dedup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockFindOrCreateRootFolder.mockResolvedValue('root-folder-id')
    mockFindFile.mockResolvedValue(null)
    mockPushMeta.mockResolvedValue('meta-file-id')
    mockFindOrCreateFolder.mockImplementation((_parentId: string, name: string) =>
      Promise.resolve(`folder-${name}`),
    )
    mockPushSnapshot.mockResolvedValue('snapshot-file-id')
    mockPushLogs.mockResolvedValue('logs-file-id')
  })

  it('推送前去重：本地残留的重复条目不会写入 Drive 文件', async () => {
    // 同一条 review 在本地 DB 中存在 14 份（历史同步 bug 的残留）
    const entry = {
      timestamp: 1001,
      type: 'review',
      childId: 'child_a',
      character: '花',
      grade: 'a',
      round: 1,
      dayKey: '2026-01-01',
    }
    const duplicated = Array(14).fill(entry)
    // 新文件场景（existingFileId=null）——pushLogs 自身不做去重，
    // 去重必须发生在 pushChanges 内
    await pushChanges(duplicated as any, MOCK_SNAPSHOT as any)

    const logLines = mockPushLogs.mock.calls[0][1] as string[]
    expect(logLines.length).toBe(1)
    expect(JSON.parse(logLines[0])).toMatchObject({ timestamp: 1001, character: '花' })
  })

  it('不同 key 的条目全部保留', async () => {
    const e1 = {
      timestamp: 1001,
      type: 'review',
      childId: 'child_a',
      character: '花',
      grade: 'a',
      round: 1,
      dayKey: '2026-01-01',
    }
    const e2 = {
      timestamp: 1002,
      type: 'review',
      childId: 'child_a',
      character: '山',
      grade: 'b',
      round: 1,
      dayKey: '2026-01-01',
    }
    await pushChanges([e1, e2, e1] as any, MOCK_SNAPSHOT as any)

    const logLines = mockPushLogs.mock.calls[0][1] as string[]
    expect(logLines.length).toBe(2)
  })
})

// ============================================================
// repairPollutedData — 启动修复：去重日志文件 + 重建污染快照
// ============================================================

describe('repairPollutedData', () => {
  const pollutedSnapshot = {
    timestamp: 1000,
    state: {
      children: [
        {
          id: 'child_a',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 1,
          progress: {
            花: {
              ease: 6.8,
              interval: 1.79e28,
              repetitions: 43,
              nextReview: 'NaN-NaN-NaN',
              lastGrade: 'a',
              firstReviewDay: '2026-05-30',
            },
          },
        },
      ],
      wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花', '山'] }],
      settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    },
  }
  const reviewEntry = {
    timestamp: 100,
    type: 'review',
    childId: 'child_a',
    character: '花',
    grade: 'a',
    round: 1,
    dayKey: '2026-07-01',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockHasValidToken.mockReturnValue(true)
    mockFindOrCreateRootFolder.mockResolvedValue('root-folder-id')
    mockFindOrCreateFolder.mockResolvedValue('child-folder-id')
    mockListFiles.mockResolvedValue([
      { id: 'log-file-id', name: 'log_2026-07-01.jsonl', modifiedTime: '2026-07-02T00:00:00.000Z' },
    ])
    mockRepairLogFile.mockResolvedValue({ repaired: true, entries: [reviewEntry] })
    mockGetLatestSnapshot.mockResolvedValue(pollutedSnapshot)
    mockGetLogsAfter.mockResolvedValue([reviewEntry])
  })

  it('不可验证的重污染字（NaN 日期）被 8a 兑底重置为 interval=1，并推送修复后的快照', async () => {
    mockFindFile.mockResolvedValue({
      id: 'snapshot-file-id',
      modifiedTime: '2026-07-02T00:00:00.000Z',
    })

    const result = await repairPollutedData()

    expect(result.snapshotRepaired).toBe(true)
    expect(result.salvaged).toBe(1)
    // 快照的 firstReviewDay(05-30) 与日志首条(07-01)不一致 → 不可验证，
    // 无法重放重建，只能兑底：interval=1、ease=2.5、nextReview 合法
    const saved = mockSaveCurrentSnapshot.mock.calls[0][0]
    const child = saved.state.children[0]
    expect(child.progress['花']).toMatchObject({ ease: 2.5, interval: 1 })
    expect(child.progress['花'].nextReview).not.toBe('NaN-NaN-NaN')
    expect(child.progress['花'].firstReviewDay).toBe('2026-05-30')
    // 修复后的快照推送到 Drive
    expect(mockPushSnapshot).toHaveBeenCalledWith(
      'child-folder-id',
      expect.any(String),
      'snapshot-file-id',
    )
  })

  it('中度污染（×3、interval 封顶）且历史完整的字被逐字修复', async () => {
    // 真实事故模式：今 3 条日志被应用 3 次 → reps 9 / interval 21362
    const jinPolluted = {
      timestamp: 1000,
      state: {
        children: [
          {
            id: 'child_a',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              今: {
                ease: 3.4,
                interval: 21362,
                repetitions: 9,
                nextReview: '2085-01-28',
                lastGrade: 'a',
                firstReviewDay: '2026-05-18',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['今', '山'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    const jinLogs = [
      {
        timestamp: 100,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-18',
      },
      {
        timestamp: 200,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-05-19',
      },
      {
        timestamp: 300,
        type: 'review',
        childId: 'child_a',
        character: '今',
        grade: 'a',
        round: 1,
        dayKey: '2026-08-04',
      },
    ]
    mockGetLatestSnapshot.mockResolvedValue(jinPolluted)
    mockGetLogsAfter.mockResolvedValue(jinLogs)
    mockRepairLogFile.mockResolvedValue({ repaired: false, entries: jinLogs })

    const result = await repairPollutedData()

    expect(result.snapshotRepaired).toBe(true)
    expect(result.salvaged).toBe(0)
    const saved = mockSaveCurrentSnapshot.mock.calls[0][0]
    expect(saved.state.children[0].progress['今']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
    })
  })

  it('重复日志文件被重写（repairLogFile 对每个 log 文件调用）', async () => {
    const result = await repairPollutedData()

    expect(mockRepairLogFile).toHaveBeenCalledWith(
      'child-folder-id',
      'log_2026-07-01.jsonl',
      'log-file-id',
    )
    expect(result.filesRepaired).toBe(1)
  })

  it('离线（无 token）时本地修复仍执行，不触碰 Drive', async () => {
    mockHasValidToken.mockReturnValue(false)

    const result = await repairPollutedData()

    expect(result.snapshotRepaired).toBe(true)
    expect(mockSaveCurrentSnapshot).toHaveBeenCalled()
    expect(mockFindOrCreateRootFolder).not.toHaveBeenCalled()
    expect(mockPushSnapshot).not.toHaveBeenCalled()
  })

  it('云端快照污染时即使本地干净也推送本地快照覆盖', async () => {
    const cleanSnapshot = JSON.parse(JSON.stringify(pollutedSnapshot))
    cleanSnapshot.state.children[0].progress['花'] = {
      ease: 2.6,
      interval: 3,
      repetitions: 1,
      nextReview: '2026-07-04',
      lastGrade: 'a',
      firstReviewDay: '2026-07-01',
    }
    mockGetLatestSnapshot.mockResolvedValue(cleanSnapshot)
    mockRepairLogFile.mockResolvedValue({ repaired: false, entries: [reviewEntry] })
    // 云端 snapshot_current.json 是污染版
    mockReadFile.mockResolvedValue(JSON.stringify(pollutedSnapshot))
    mockListFiles.mockResolvedValue([
      { id: 'log-file-id', name: 'log_2026-07-01.jsonl', modifiedTime: '2026-07-02T00:00:00.000Z' },
      {
        id: 'snap-file-id',
        name: 'snapshot_current.json',
        modifiedTime: '2026-07-02T00:00:00.000Z',
      },
    ])

    const result = await repairPollutedData()

    expect(result.snapshotRepaired).toBe(false)
    expect(mockSaveCurrentSnapshot).not.toHaveBeenCalled()
    expect(mockPushSnapshot).toHaveBeenCalled()
  })

  it('数据干净时不做任何修改', async () => {
    const cleanSnapshot = JSON.parse(JSON.stringify(pollutedSnapshot))
    cleanSnapshot.state.children[0].progress['花'] = {
      ease: 2.6,
      interval: 3,
      repetitions: 1,
      nextReview: '2026-07-04',
      lastGrade: 'a',
      firstReviewDay: '2026-07-01',
    }
    mockGetLatestSnapshot.mockResolvedValue(cleanSnapshot)
    mockRepairLogFile.mockResolvedValue({ repaired: false, entries: [reviewEntry] })
    mockReadFile.mockResolvedValue(JSON.stringify(cleanSnapshot))
    mockListFiles.mockResolvedValue([
      { id: 'log-file-id', name: 'log_2026-07-01.jsonl', modifiedTime: '2026-07-02T00:00:00.000Z' },
      {
        id: 'snap-file-id',
        name: 'snapshot_current.json',
        modifiedTime: '2026-07-02T00:00:00.000Z',
      },
    ])

    const result = await repairPollutedData()

    expect(result.snapshotRepaired).toBe(false)
    expect(result.filesRepaired).toBe(0)
    expect(result.salvaged).toBe(0)
    expect(mockSaveCurrentSnapshot).not.toHaveBeenCalled()
    expect(mockPushSnapshot).not.toHaveBeenCalled()
  })
})

describe('initialPull pollution guard', () => {
  const pollutedRemoteSnapshot = {
    timestamp: 9999,
    state: {
      children: [
        {
          id: 'child_a',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 1,
          progress: {
            花: {
              ease: 6.8,
              interval: 1.79e28,
              repetitions: 43,
              nextReview: 'NaN-NaN-NaN',
              lastGrade: 'a',
              firstReviewDay: '2026-05-30',
            },
          },
        },
      ],
      wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花', '山'] }],
      settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    },
  }
  const localCleanSnapshot = {
    timestamp: 1000,
    state: {
      children: [
        {
          id: 'child_a',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 1,
          progress: {
            花: {
              ease: 2.6,
              interval: 3,
              repetitions: 1,
              nextReview: '2026-07-04',
              lastGrade: 'a',
              firstReviewDay: '2026-07-01',
            },
          },
        },
      ],
      wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花', '山'] }],
      settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockHasValidToken.mockReturnValue(true)
    mockGetLatestSnapshot.mockResolvedValue(localCleanSnapshot)
    mockGetLogsAfter.mockResolvedValue([])
  })

  it('远程快照被污染时不覆盖本地快照（阻止污染传播）', async () => {
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        小明: {
          snapshot: JSON.stringify(pollutedRemoteSnapshot),
          logs: [],
        },
      },
    })

    await initialPull()

    // 本地干净快照（timestamp 1000）不应被远程污染快照（9999）覆盖
    expect(mockSaveCurrentSnapshot).not.toHaveBeenCalledWith(
      expect.objectContaining({ timestamp: 9999 }),
    )
  })
})
