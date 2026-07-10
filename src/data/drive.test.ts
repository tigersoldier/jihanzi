/**
 * @vitest-environment jsdom
 *
 * Tests for Google Drive file operations — verifies correct API usage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock the gapi module (getAccessToken, setGapiToken)
vi.mock('./gapi', () => ({
  getAccessToken: vi.fn().mockResolvedValue('mock-access-token'),
  setGapiToken: vi.fn(),
}))

// Global gapi mock — set up per test
const mockGapiRequest = vi.fn()

beforeEach(() => {
  mockGapiRequest.mockReset()
  vi.stubGlobal('gapi', {
    client: {
      request: mockGapiRequest,
      drive: {
        files: {
          list: vi.fn().mockResolvedValue({ result: { files: [] } }),
          create: vi.fn().mockImplementation(({ resource }) =>
            Promise.resolve({ result: { id: `mock-id-${resource.name}` } }),
          ),
          get: vi.fn(),
        },
      },
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import { writeFile, pushLogs, readFile, logFileName, snapshotFileName, listFiles, pushSnapshot } from './drive'
import { makeDiffKey } from '../utils/logKey'

describe('writeFile', () => {
  it('sends multipart body as a string (not FormData) so gapi can handle it', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-abc-123' } })

    const fileId = await writeFile(
      'folder-xyz',
      'snapshot.json',
      '{"version":1}',
      'application/json; charset=utf-8',
    )

    expect(fileId).toBe('file-abc-123')
    expect(mockGapiRequest).toHaveBeenCalledTimes(1)

    const reqConfig = mockGapiRequest.mock.calls[0][0]

    // Verify the request shape
    expect(reqConfig.path).toBe('/upload/drive/v3/files')
    expect(reqConfig.method).toBe('POST')
    expect(reqConfig.params).toEqual({ uploadType: 'multipart' })

    // KEY ASSERTION: body must be a string, NOT a FormData.
    // FormData instances don't serialize correctly through gapi's request layer.
    expect(typeof reqConfig.body).toBe('string')

    // Verify multipart structure
    const body = reqConfig.body as string
    expect(body).toContain('Content-Type: application/json; charset=utf-8')
    expect(body).toContain('"name":"snapshot.json"')
    expect(body).toContain('{"version":1}')
  })

  it('includes multipart Content-Type header with boundary', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-456' } })

    await writeFile('folder-xyz', 'log.jsonl', '{"entry":1}\n', 'application/json; charset=utf-8')

    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.headers).toBeDefined()
    expect(reqConfig.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/)
    expect(reqConfig.body).toContain('Content-Type: application/json; charset=utf-8')
  })

  it('updates an existing file with media upload (not multipart)', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-id' } })

    const fileId = await writeFile(
      'folder-xyz',
      'app_meta.json',
      '{"lastSync":123}',
      'application/json; charset=utf-8',
      'existing-id', // existingFileId
    )

    expect(fileId).toBe('existing-id')
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.path).toBe('/upload/drive/v3/files/existing-id')
    expect(reqConfig.method).toBe('PATCH')
    expect(reqConfig.params).toEqual({ uploadType: 'media' })
  })

  it('includes charset=utf-8 in PATCH Content-Type header for media uploads', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-id' } })

    await writeFile(
      'folder-xyz',
      'log.jsonl',
      '{"entry":"花"}\n',
      'application/json; charset=utf-8',
      'existing-id',
    )

    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  it('includes charset=utf-8 in multipart content part header', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-new' } })

    await writeFile(
      'folder-xyz',
      'log.jsonl',
      '{"entry":"花"}\n',
      'application/json; charset=utf-8',
    )

    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.body).toContain('Content-Type: application/json; charset=utf-8')
  })

  it('default mimeType includes charset=utf-8', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-default' } })

    // No existingFileId → multipart upload; charset goes in the body part header
    await writeFile('folder-xyz', 'snapshot.json', '{"state":{}}')

    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.body).toContain('Content-Type: application/json; charset=utf-8')
  })
})

describe('readFile', () => {
  const mockFetch = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
  })

  it('decodes UTF-8 Chinese characters correctly', async () => {
    const testContent = '{"character":"修","grade":"a"}\n{"character":"奏","grade":"b"}\n'
    const utf8Bytes = new TextEncoder().encode(testContent)

    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(utf8Bytes.buffer.slice(0)),
    })

    const result = await readFile('file-id-123')

    expect(mockFetch).toHaveBeenCalledTimes(1)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://www.googleapis.com/drive/v3/files/file-id-123?alt=media',
      { headers: { Authorization: 'Bearer mock-access-token' } },
    )
    expect(result).toBe(testContent)
    expect(result).toContain('修')
    expect(result).toContain('奏')
  })

  it('throws on HTTP error response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
    })

    await expect(readFile('bad-file-id')).rejects.toThrow('Failed to read file')
  })
})

describe('pushLogs', () => {
  const mockGapiRequest = vi.fn()
  const mockFetch = vi.fn()
  const logEntries = [
    '{"timestamp":1,"type":"review","childId":"c1","character":"花","grade":"a","round":1,"dayKey":"2026-01-01"}',
    '{"timestamp":2,"type":"review","childId":"c1","character":"山","grade":"b","round":1,"dayKey":"2026-01-01"}',
    '{"timestamp":3,"type":"review","childId":"c1","character":"水","grade":"c","round":1,"dayKey":"2026-01-01"}',
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockGapiRequest.mockReset()
    mockFetch.mockReset()
    vi.stubGlobal('fetch', mockFetch)
    // Re-set gapi mock without files.get (readFile now uses fetch)
    vi.stubGlobal('gapi', {
      client: {
        request: mockGapiRequest,
        drive: {
          files: {
            list: vi.fn().mockResolvedValue({ result: { files: [] } }),
            create: vi.fn().mockImplementation(({ resource }) =>
              Promise.resolve({ result: { id: `mock-id-${resource.name}` } }),
            ),
          },
        },
      },
    })
  })

  it('batches multiple entries into a single gapi read + single write (not N read-modify-write cycles)', async () => {
    // Existing log file with some content
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode('{"old":"entry"}\n').buffer.slice(0)),
    })
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-log-id' } })

    await pushLogs('folder-abc', logEntries, 'existing-log-id')

    // KEY ASSERTION: only ONE read (fetch)
    expect(mockFetch).toHaveBeenCalledTimes(1)

    // KEY ASSERTION: only ONE write (gapi.client.request for PATCH)
    expect(mockGapiRequest).toHaveBeenCalledTimes(1)

    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.method).toBe('PATCH')
    expect(reqConfig.path).toBe('/upload/drive/v3/files/existing-log-id')

    // All three entries should be in the body
    expect(reqConfig.body).toContain('{"old":"entry"}')
    expect(reqConfig.body).toContain('"timestamp":1')
    expect(reqConfig.body).toContain('"timestamp":2')
    expect(reqConfig.body).toContain('"timestamp":3')
  })

  it('creates a new file with all entries when no existing file', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'new-log-id' } })

    await pushLogs('folder-abc', logEntries, null)

    // No read when creating a new file
    expect(mockFetch).not.toHaveBeenCalled()

    // Single write
    expect(mockGapiRequest).toHaveBeenCalledTimes(1)
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.method).toBe('POST')
    expect(reqConfig.path).toBe('/upload/drive/v3/files')

    // All entries should be in the body
    expect(reqConfig.body).toContain('"timestamp":1')
    expect(reqConfig.body).toContain('"timestamp":2')
    expect(reqConfig.body).toContain('"timestamp":3')
  })

  it('returns the file id after pushing (returns existingFileId for updates)', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    })
    mockGapiRequest.mockResolvedValue({ result: { id: 'returned-id' } })

    const result = await pushLogs('folder-abc', [logEntries[0]], 'existing-log-id')
    expect(result).toBe('existing-log-id')
  })

  it('returns a new file id when creating a new log file', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'new-file-id' } })

    const result = await pushLogs('folder-abc', [logEntries[0]], null)
    expect(result).toBe('new-file-id')
  })

  it('skips read and write when logEntries is empty (no-op for existing file)', async () => {
    await pushLogs('folder-abc', [], 'existing-log-id')

    // Must NOT read or write — nothing to append
    expect(mockFetch).not.toHaveBeenCalled()
    expect(mockGapiRequest).not.toHaveBeenCalled()
  })

  it('skips write when logEntries is empty (no-op for new file)', async () => {
    await pushLogs('folder-abc', [], null)

    // Must NOT create an empty file with just a newline
    expect(mockGapiRequest).not.toHaveBeenCalled()
  })

  // ---- Dedup: filter out entries already present in the Drive file ----

  it('filters out entries already present in the Drive file (content-based dedup)', async () => {
    // Existing file has entries 0 and 1
    const existingLines = [logEntries[0], logEntries[1]]
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(
        new TextEncoder().encode(existingLines.join('\n') + '\n').buffer.slice(0),
      ),
    })
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-log-id' } })

    // Push all 3 entries; only entry 2 (timestamp 3) is actually new
    await pushLogs('folder-abc', logEntries, 'existing-log-id')

    expect(mockGapiRequest).toHaveBeenCalledTimes(1)
    const reqConfig = mockGapiRequest.mock.calls[0][0]

    // Verify: existing content preserved, only new entry appended
    const body = reqConfig.body as string
    const lines = body.split('\n').filter((l: string) => l.trim())
    // 2 existing + 1 new = 3 lines, no duplicates
    expect(lines).toHaveLength(3)
    expect(body).toContain('"timestamp":1')
    expect(body).toContain('"timestamp":2')
    expect(body).toContain('"timestamp":3')
    // Each timestamp should appear exactly once
    expect(body.split('"timestamp":1').length).toBe(2) // split yields 2 parts = 1 occurrence
    expect(body.split('"timestamp":2').length).toBe(2)
  })

  it('skips write entirely when all entries already exist on Drive', async () => {
    // Existing file has all 3 entries
    const existingContent = logEntries.join('\n') + '\n'
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(
        new TextEncoder().encode(existingContent).buffer.slice(0),
      ),
    })
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-log-id' } })

    await pushLogs('folder-abc', logEntries, 'existing-log-id')

    // Nothing new to push → no write needed
    expect(mockGapiRequest).not.toHaveBeenCalled()
  })

  it('deduplicates against existing file even when file has trailing whitespace', async () => {
    // Existing file has entries 0 and 1 with trailing newline
    const existingContent = logEntries[0] + '\n' + logEntries[1] + '\n\n'
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(
        new TextEncoder().encode(existingContent).buffer.slice(0),
      ),
    })
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-log-id' } })

    await pushLogs('folder-abc', logEntries, 'existing-log-id')

    expect(mockGapiRequest).toHaveBeenCalledTimes(1)
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    const body = reqConfig.body as string
    const lines = body.split('\n').filter((l: string) => l.trim())
    expect(lines).toHaveLength(3) // 2 existing + 1 new
  })

  it('handles empty existing file (no existing entries)', async () => {
    // Existing file is empty
    mockFetch.mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    })
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-log-id' } })

    await pushLogs('folder-abc', logEntries, 'existing-log-id')

    expect(mockGapiRequest).toHaveBeenCalledTimes(1)
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    const body = reqConfig.body as string
    const lines = body.split('\n').filter((l: string) => l.trim())
    expect(lines).toHaveLength(3) // all 3 entries written
  })
})

// ============================================================
// Interval-based file naming
// ============================================================

describe('logFileName', () => {
  it('returns log_{intervalKey}.jsonl', () => {
    expect(logFileName('2026-07-01')).toBe('log_2026-07-01.jsonl')
    expect(logFileName('2026-07-11')).toBe('log_2026-07-11.jsonl')
    expect(logFileName('2026-07-21')).toBe('log_2026-07-21.jsonl')
  })
})

describe('snapshotFileName', () => {
  it('returns snapshot_{intervalKey}.json for historical snapshots', () => {
    expect(snapshotFileName('2026-07-01')).toBe('snapshot_2026-07-01.json')
    expect(snapshotFileName('2026-06-21')).toBe('snapshot_2026-06-21.json')
  })
})

// ============================================================
// listFiles
// ============================================================

describe('listFiles', () => {
  it('lists all non-trashed files in a folder', async () => {
    const mockList = vi.fn().mockResolvedValue({
      result: {
        files: [
          { id: 'f1', name: 'snapshot_current.json', modifiedTime: '2026-07-01T00:00:00Z' },
          { id: 'f2', name: 'log_2026-07-01.jsonl', modifiedTime: '2026-07-01T00:00:00Z' },
          { id: 'f3', name: 'log_2026-07-11.jsonl', modifiedTime: '2026-07-11T00:00:00Z' },
        ],
      },
    })
    vi.stubGlobal('gapi', {
      client: {
        request: vi.fn(),
        drive: { files: { list: mockList } },
      },
    })

    const files = await listFiles('folder-id')
    expect(files).toHaveLength(3)
    expect(files[0].name).toBe('snapshot_current.json')
    expect(files[2].name).toBe('log_2026-07-11.jsonl')
  })

  it('filters by modifiedTime when modifiedAfter is provided', async () => {
    const mockList = vi.fn().mockResolvedValue({
      result: {
        files: [
          { id: 'f1', name: 'snapshot_current.json', modifiedTime: '2026-07-05T12:00:00Z' },
        ],
      },
    })
    vi.stubGlobal('gapi', {
      client: {
        request: vi.fn(),
        drive: { files: { list: mockList } },
      },
    })

    await listFiles('folder-id', '2026-07-04T00:00:00Z')
    const query = mockList.mock.calls[0][0].q
    expect(query).toContain("modifiedTime > '2026-07-04T00:00:00Z'")
  })

  it('does not filter by modifiedTime when modifiedAfter is not provided', async () => {
    const mockList = vi.fn().mockResolvedValue({
      result: { files: [] },
    })
    vi.stubGlobal('gapi', {
      client: {
        request: vi.fn(),
        drive: { files: { list: mockList } },
      },
    })

    await listFiles('folder-id')
    const query = mockList.mock.calls[0][0].q
    expect(query).not.toContain('modifiedTime')
  })
})

// ============================================================
// pushSnapshot with custom filename
// ============================================================

describe('pushSnapshot', () => {
  const mockGapiRequest = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGapiRequest.mockReset()
    mockGapiRequest.mockResolvedValue({ result: { id: 'snap-id' } })
    vi.stubGlobal('gapi', {
      client: {
        request: mockGapiRequest,
        drive: { files: { list: vi.fn().mockResolvedValue({ result: { files: [] } }) } },
      },
    })
  })

  it('writes to snapshot_current.json by default', async () => {
    await pushSnapshot('folder-id', '{"state":{}}')
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.body).toContain('"name":"snapshot_current.json"')
  })

  it('writes to custom filename when provided', async () => {
    await pushSnapshot('folder-id', '{"state":{}}', null, 'snapshot_2026-07-01.json')
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.body).toContain('"name":"snapshot_2026-07-01.json"')
  })
})

// ============================================================
// pushLogs with custom filename
// ============================================================

describe('pushLogs with interval filename', () => {
  const mockGapiRequest = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockGapiRequest.mockReset()
    mockGapiRequest.mockResolvedValue({ result: { id: 'log-id' } })
    vi.stubGlobal('gapi', {
      client: {
        request: mockGapiRequest,
        drive: { files: { list: vi.fn().mockResolvedValue({ result: { files: [] } }) } },
      },
    })
  })

  it('writes to custom filename when provided (interval-based)', async () => {
    await pushLogs('folder-id', ['{"entry":1}'], null, 'log_2026-07-01.jsonl')
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.body).toContain('"name":"log_2026-07-01.jsonl"')
  })
})
