/**
 * @vitest-environment node
 *
 * Tests for sync orchestrator — verifies correct sync behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAllLogs, mockGetLogsAfter, mockGetLatestSnapshot, mockGetLastSyncTime } = vi.hoisted(() => ({
  mockGetAllLogs: vi.fn(),
  mockGetLogsAfter: vi.fn(),
  mockGetLatestSnapshot: vi.fn(),
  mockGetLastSyncTime: vi.fn().mockResolvedValue(0),
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

const { mockPullAllData, mockSaveSnapshot, mockAppendLogs } = vi.hoisted(() => ({
  mockPullAllData: vi.fn(),
  mockSaveSnapshot: vi.fn(),
  mockAppendLogs: vi.fn(),
}))

vi.mock('./drive', () => ({
  findOrCreateRootFolder: (...args: any[]) => mockFindOrCreateRootFolder(...args),
  findOrCreateFolder: (...args: any[]) => mockFindOrCreateFolder(...args),
  findFile: (...args: any[]) => mockFindFile(...args),
  pullAllData: (...args: any[]) => mockPullAllData(...args),
  pushMeta: (...args: any[]) => mockPushMeta(...args),
  pushSnapshot: (...args: any[]) => mockPushSnapshot(...args),
  pushLogs: (...args: any[]) => mockPushLogs(...args),
}))

vi.mock('./gapi', () => ({
  hasValidToken: () => mockHasValidToken(),
  getAccessToken: vi.fn(),
  setGapiToken: vi.fn(),
}))

vi.mock('./db', () => ({
  getAllLogs: () => mockGetAllLogs(),
  getLogsAfter: (...args: any[]) => mockGetLogsAfter(...args),
  getLatestSnapshot: () => mockGetLatestSnapshot(),
  getLastSyncTime: () => mockGetLastSyncTime(),
  setLastSyncTime: vi.fn(),
  saveSnapshot: (...args: any[]) => mockSaveSnapshot(...args),
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

import { pushChanges, initialPull } from './sync'

describe('pushChanges', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockHasValidToken.mockReturnValue(true)
    mockGetAllLogs.mockResolvedValue(MOCK_LOG_ENTRIES)
    mockGetLatestSnapshot.mockResolvedValue(MOCK_SNAPSHOT)
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
    await pushChanges()

    expect(mockFindOrCreateRootFolder).toHaveBeenCalled()
    expect(mockPushMeta).toHaveBeenCalledWith(
      'root-folder-id',
      expect.objectContaining({ version: '0.1.0', lastSyncTime: expect.any(Number) }),
      undefined, // no existing file → undefined (from metaFile?.id)
    )
  })

  it('creates a subfolder and pushes snapshot + logs for each child', async () => {
    await pushChanges()

    // Two children → two subfolders
    expect(mockFindOrCreateFolder).toHaveBeenCalledTimes(2)
    expect(mockFindOrCreateFolder).toHaveBeenCalledWith('root-folder-id', '小明')
    expect(mockFindOrCreateFolder).toHaveBeenCalledWith('root-folder-id', '小红')

    // Snapshot pushed to each child folder (full state)
    expect(mockPushSnapshot).toHaveBeenCalledTimes(2)

    // Logs pushed to each child folder
    expect(mockPushLogs).toHaveBeenCalledTimes(2)
  })

  it('skips Drive push when token is invalid', async () => {
    mockHasValidToken.mockReturnValue(false)

    await pushChanges()

    expect(mockFindOrCreateRootFolder).not.toHaveBeenCalled()
  })

  it('only pushes new log entries (since last sync), not all logs', async () => {
    // After first sync, lastSyncTime is set
    mockGetLastSyncTime.mockResolvedValue(1000)

    // getAllLogs would return all 100 entries, but getLogsAfter should only
    // return the 5 entries created after timestamp 1000
    const newEntries = MOCK_LOG_ENTRIES.slice(0, 1) // Just one new entry
    mockGetLogsAfter.mockResolvedValue(newEntries)

    await pushChanges()

    // Should NOT have called getAllLogs (which returns everything)
    expect(mockGetAllLogs).not.toHaveBeenCalled()

    // Should have called getLogsAfter with the last sync timestamp
    expect(mockGetLogsAfter).toHaveBeenCalledWith(1000)

    // Should push only the new entries, not all of them
    const pushedEntries = mockPushLogs.mock.calls[0][1] as string[]
    expect(pushedEntries.length).toBe(1)
    expect(pushedEntries[0]).toContain('child_a')
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
  '{"timestamp":2001,"type":"create_child","childId":"child_x","name":"小明","wordBookId":"wb_1"}',
  '{"timestamp":2002,"type":"create_wordbook","wordBookId":"wb_1","name":"生字本","characters":["一","二","三","四","五"]}',
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
    mockGetAllLogs.mockResolvedValue([])
    mockGetLatestSnapshot.mockResolvedValue(null)
    mockPullAllData.mockResolvedValue({
      meta: { lastSyncTime: Date.now(), version: '0.1.0' },
      childData: MOCK_REMOTE_CHILD_DATA,
    })
  })

  // ---- Tracer bullet: data from Drive is saved to local IndexedDB ----

  it('saves pulled snapshot and log entries to IndexedDB', async () => {
    await initialPull()

    // Snapshot saved
    expect(mockSaveSnapshot).toHaveBeenCalledTimes(1)
    expect(mockSaveSnapshot).toHaveBeenCalledWith(
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

    expect(mockSaveSnapshot).not.toHaveBeenCalled()
    expect(mockAppendLogs).not.toHaveBeenCalled()
  })

  // ---- Edge: invalid token skips pull entirely ----

  it('skips pull when token is invalid', async () => {
    mockHasValidToken.mockReturnValue(false)

    await initialPull()

    expect(mockPullAllData).not.toHaveBeenCalled()
  })

  // ---- Merge: does not duplicate log entries already present locally ----

  it('only appends new log entries not already in local IndexedDB', async () => {
    // Local already has the first log entry
    mockGetAllLogs.mockResolvedValue([
      { timestamp: 2001, type: 'create_child', childId: 'child_x', name: '小明', wordBookId: 'wb_1' },
    ])

    await initialPull()

    expect(mockAppendLogs).toHaveBeenCalledTimes(1)
    const appendedLogs = mockAppendLogs.mock.calls[0][0] as any[]
    expect(appendedLogs.length).toBe(1)
    expect(appendedLogs[0]).toMatchObject({ timestamp: 2002, type: 'create_wordbook' })
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
    const saveCalls = mockSaveSnapshot.mock.calls
    const overwriteCall = saveCalls.find(
      (call: any[]) => call[0]?.timestamp === MOCK_REMOTE_SNAPSHOT.timestamp,
    )
    expect(overwriteCall).toBeUndefined()
  })
})
