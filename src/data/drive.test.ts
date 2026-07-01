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

import { writeFile } from './drive'

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
