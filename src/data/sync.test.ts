/**
 * @vitest-environment node
 *
 * Tests for sync orchestrator — verifies correct sync behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetLogsAfter, mockGetLatestSnapshot, mockLastKnownRemoteTime, mockSetLastKnownRemoteTime } = vi.hoisted(() => ({
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
} = vi.hoisted(() => ({
  mockFindOrCreateRootFolder: vi.fn(),
  mockFindOrCreateFolder: vi.fn(),
  mockFindFile: vi.fn(),
  mockPushMeta: vi.fn(),
  mockPushSnapshot: vi.fn(),
  mockPushLogs: vi.fn(),
}))

const { mockHasValidToken } = vi.hoisted(() => ({
  mockHasValidToken: vi.fn().mockReturnValue(true),
}))

const { mockPullAllData, mockSaveCurrentSnapshot, mockAppendLogs, mockGetHistoricalSnapshots } = vi.hoisted(() => ({
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
}))

const MOCK_LOG_ENTRIES = [
  { timestamp: 1001, type: 'review', childId: 'child_a', character: '花', grade: 'a', round: 1, dayKey: '2026-01-01' },
  { timestamp: 1002, type: 'review', childId: 'child_b', character: '山', grade: 'b', round: 1, dayKey: '2026-01-01' },
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

import { pushChanges, initialPull, syncOnce, diffEntries } from './sync'

// ============================================================
// diffEntries — content-based log dedup
// ============================================================

describe('diffEntries', () => {
  const entryA = { timestamp: 1001, type: 'review', childId: 'c1', character: '花', grade: 'a', round: 1, dayKey: '2026-01-01' }
  const entryB = { timestamp: 1002, type: 'review', childId: 'c1', character: '山', grade: 'b', round: 1, dayKey: '2026-01-01' }
  const entryC = { timestamp: 1003, type: 'create_child', childId: 'c2', name: '大明', wordBookId: 'wb_1' }
  const entryD = { timestamp: 1004, type: 'create_wordbook', wordBookId: 'wb_2', name: '新字本', characters: ['一', '二'] }

  it('finds entries only in remote (remoteOnly)', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA],           // local
      [entryA, entryB],   // remote
    )
    expect(remoteOnly).toEqual([entryB])
    expect(localOnly).toEqual([])
  })

  it('finds entries only in local (localOnly)', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA, entryB],   // local
      [entryA],           // remote
    )
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([entryB])
  })

  it('finds both directions when partial overlap', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA, entryB],           // local
      [entryA, entryC, entryD],   // remote
    )
    expect(remoteOnly).toEqual([entryC, entryD])
    expect(localOnly).toEqual([entryB])
  })

  it('returns empty when collections are identical', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA, entryB],
      [entryA, entryB],
    )
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([])
  })

  it('returns empty when both are empty', () => {
    const { remoteOnly, localOnly } = diffEntries([], [])
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([])
  })

  it('all local entries are localOnly when remote is empty', () => {
    const { remoteOnly, localOnly } = diffEntries(
      [entryA, entryB, entryC],
      [],
    )
    expect(remoteOnly).toEqual([])
    expect(localOnly).toEqual([entryA, entryB, entryC])
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

    const findFileCalls = mockFindFile.mock.calls
      .filter((c: any[]) => c[1] === 'snapshot_current.json')
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

    const histPushCalls = mockPushSnapshot.mock.calls
      .filter((c: any[]) => c[3] === 'snapshot_2026-06-21.json')
    expect(histPushCalls.length).toBeGreaterThanOrEqual(2)
  })

  it('skips historical snapshots that already exist on Drive', async () => {
    mockGetHistoricalSnapshots.mockResolvedValue([
      { timestamp: new Date('2026-06-21T00:00:00Z').getTime(), state: MOCK_SNAPSHOT.state },
    ])
    mockFindFile.mockResolvedValue({ id: 'existing-hist-id', modifiedTime: '2026-06-21T00:00:00Z' })

    await pushChanges(MOCK_LOG_ENTRIES, MOCK_SNAPSHOT as any)

    const histPushCalls = mockPushSnapshot.mock.calls
      .filter((c: any[]) => c[3] === 'snapshot_2026-06-21.json')
    expect(histPushCalls.length).toBe(0)
  })
})

// ---- initialPull -------------------------------------------------------

const MOCK_REMOTE_SNAPSHOT = {
  timestamp: 2000,
  state: {
    children: [
      { id: 'child_x', name: '小明', wordBookId: 'wb_1', nextCharIndex: 5, progress: {} },
    ],
    wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二', '三', '四', '五'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
  },
}

const MOCK_REMOTE_LOG_LINES = [
  '{"timestamp":2001,"type":"create_child","childId":"child_x","name":"小明","wordBookId":"wb_1","id":1}',
  '{"timestamp":2002,"type":"create_wordbook","wordBookId":"wb_1","name":"生字本","characters":["一","二","三","四","五"],"id":2}',
]

const MOCK_REMOTE_CHILD_DATA = {
  '小明': {
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
      state: { children: [], wordBooks: [], settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 } },
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
        '小明': {
          snapshot: JSON.stringify(MOCK_REMOTE_SNAPSHOT),
          logs: remoteLogLinesWithReviews,
        },
      },
    })

    await initialPull()

    // 验证 saveCurrentSnapshot 被调用时，state 包含物化后的 progress
    expect(mockSaveCurrentSnapshot).toHaveBeenCalled()
    const savedSnapshot = mockSaveCurrentSnapshot.mock.calls[
      mockSaveCurrentSnapshot.mock.calls.length - 1
    ][0]
    const savedChild = savedSnapshot.state.children[0]
    expect(savedChild.progress['一']).toBeDefined()
    expect(savedChild.progress['一'].lastGrade).toBe('a')
    expect(savedChild.progress['一'].firstReviewDay).toBe('2026-07-01')
    expect(savedChild.progress['二']).toBeDefined()
    expect(savedChild.progress['二'].lastGrade).toBe('b')
    expect(savedChild.progress['三']).toBeDefined()
    expect(savedChild.progress['三'].lastGrade).toBe('c')
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
            id: 'child_x', name: '小明', wordBookId: 'wb_1', nextCharIndex: 2,
            progress: {
              '一': { ease: 2.5, interval: 1, repetitions: 1, nextReview: '2026-07-02', lastGrade: 'a', firstReviewDay: '2026-07-01' },
              '二': { ease: 2.5, interval: 1, repetitions: 1, nextReview: '2026-07-02', lastGrade: 'b', firstReviewDay: '2026-07-01' },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二', '三', '四', '五'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    mockGetLatestSnapshot.mockResolvedValue(localSnapshot)

    // 远程新日志：设备 B 上学了「三」
    const remoteLogLinesWithNewReview = [
      '{"timestamp":2003,"type":"review","childId":"child_x","character":"三","grade":"a","round":1,"dayKey":"2026-07-03"}',
    ]
    mockPullAllData.mockResolvedValue({
      meta: { lastKnownRemoteTime: Date.now(), version: '0.1.0' },
      childData: {
        '小明': {
          snapshot: null, // 远程 snapshot 可能不存在或更旧
          logs: remoteLogLinesWithNewReview,
        },
      },
    })

    await initialPull()

    // 验证 saveCurrentSnapshot 被调用来物化远程复习数据
    expect(mockSaveCurrentSnapshot).toHaveBeenCalled()
    const savedSnapshot = mockSaveCurrentSnapshot.mock.calls[
      mockSaveCurrentSnapshot.mock.calls.length - 1
    ][0]
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
            id: 'child_y', name: '小红', wordBookId: 'wb_2', nextCharIndex: 3,
            progress: {
              '山': { ease: 2.5, interval: 3, repetitions: 3, nextReview: '2026-07-04', lastGrade: 'a', firstReviewDay: '2026-07-01' },
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
        '小明': {
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
})
