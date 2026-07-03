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

import { writeFile, pushLogs } from './drive'

describe('writeFile', () => {
  it('sends multipart body as a string (not FormData) so gapi can handle it', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-abc-123' } })

    const fileId = await writeFile(
      'folder-xyz',
      'snapshot.json',
      '{"version":1}',
      'application/json',
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
    expect(body).toContain('Content-Type: application/json; charset=UTF-8')
    expect(body).toContain('"name":"snapshot.json"')
    expect(body).toContain('{"version":1}')
  })

  it('includes multipart Content-Type header with boundary', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'file-456' } })

    await writeFile('folder-xyz', 'log.jsonl', '{"entry":1}\n', 'application/x-ndjson')

    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.headers).toBeDefined()
    expect(reqConfig.headers['Content-Type']).toMatch(/^multipart\/related; boundary=/)
    expect(reqConfig.body).toContain('Content-Type: application/x-ndjson')
  })

  it('updates an existing file with media upload (not multipart)', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-id' } })

    const fileId = await writeFile(
      'folder-xyz',
      'app_meta.json',
      '{"lastSync":123}',
      'application/json',
      'existing-id', // existingFileId
    )

    expect(fileId).toBe('existing-id')
    const reqConfig = mockGapiRequest.mock.calls[0][0]
    expect(reqConfig.path).toBe('/upload/drive/v3/files/existing-id')
    expect(reqConfig.method).toBe('PATCH')
    expect(reqConfig.params).toEqual({ uploadType: 'media' })
  })
})

describe('pushLogs', () => {
  // Track calls to gapi.client.drive.files.get (used by readFile)
  // and gapi.client.request (used by writeFile)
  const mockFilesGet = vi.fn()
  const logEntries = [
    '{"timestamp":1,"type":"review","childId":"c1","character":"花","grade":"a","round":1,"dayKey":"2026-01-01"}',
    '{"timestamp":2,"type":"review","childId":"c1","character":"山","grade":"b","round":1,"dayKey":"2026-01-01"}',
    '{"timestamp":3,"type":"review","childId":"c1","character":"水","grade":"c","round":1,"dayKey":"2026-01-01"}',
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    mockGapiRequest.mockReset()
    mockFilesGet.mockReset()
    // Re-set gapi mock with files.get tracking
    vi.stubGlobal('gapi', {
      client: {
        request: mockGapiRequest,
        drive: {
          files: {
            list: vi.fn().mockResolvedValue({ result: { files: [] } }),
            create: vi.fn().mockImplementation(({ resource }) =>
              Promise.resolve({ result: { id: `mock-id-${resource.name}` } }),
            ),
            get: mockFilesGet,
          },
        },
      },
    })
  })

  it('batches multiple entries into a single gapi read + single write (not N read-modify-write cycles)', async () => {
    // Existing log file with some content
    mockFilesGet.mockResolvedValue({ body: '{"old":"entry"}\n' })
    mockGapiRequest.mockResolvedValue({ result: { id: 'existing-log-id' } })

    await pushLogs('folder-abc', logEntries, 'existing-log-id')

    // KEY ASSERTION: only ONE read (gapi.client.drive.files.get)
    expect(mockFilesGet).toHaveBeenCalledTimes(1)

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
    expect(mockFilesGet).not.toHaveBeenCalled()

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
    mockFilesGet.mockResolvedValue({ body: '' })
    mockGapiRequest.mockResolvedValue({ result: { id: 'returned-id' } })

    const result = await pushLogs('folder-abc', [logEntries[0]], 'existing-log-id')
    expect(result).toBe('existing-log-id')
  })

  it('returns a new file id when creating a new log file', async () => {
    mockGapiRequest.mockResolvedValue({ result: { id: 'new-file-id' } })

    const result = await pushLogs('folder-abc', [logEntries[0]], null)
    expect(result).toBe('new-file-id')
  })
})
