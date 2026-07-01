/**
 * @vitest-environment node
 *
 * Tests for sync orchestrator — verifies correct sync behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockGetAllLogs, mockGetLatestSnapshot } = vi.hoisted(() => ({
  mockGetAllLogs: vi.fn(),
  mockGetLatestSnapshot: vi.fn(),
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

vi.mock('./drive', () => ({
  findOrCreateRootFolder: (...args: any[]) => mockFindOrCreateRootFolder(...args),
  findOrCreateFolder: (...args: any[]) => mockFindOrCreateFolder(...args),
  findFile: (...args: any[]) => mockFindFile(...args),
  pullAllData: vi.fn(),
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
  getLatestSnapshot: () => mockGetLatestSnapshot(),
  getLastSyncTime: vi.fn(),
  setLastSyncTime: vi.fn(),
  saveSnapshot: vi.fn(),
  appendLog: vi.fn(),
  appendLogs: vi.fn(),
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

import { pushChanges } from './sync'

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
})
