/**
 * Google Drive API Operations
 *
 * Manages the folder structure on Google Drive:
 *
 *   记汉字/
 *   ├── app_meta.json
 *   ├── {childName}/
 *   │   ├── snapshot.json
 *   │   └── log.jsonl
 */

import { getAccessToken, setGapiToken, clearTokenStorage } from './gapi'

const ROOT_FOLDER_NAME = '记汉字'
const META_FILE_NAME = 'app_meta.json'
const SNAPSHOT_CURRENT_FILE_NAME = 'snapshot_current.json'
const SNAPSHOT_LEGACY_FILE_NAME = 'snapshot.json'

/** Build a log file name for a given UTC interval key: log_{key}.jsonl */
export function logFileName(intervalKey: string): string {
  return `log_${intervalKey}.jsonl`
}

/** Build a historical snapshot file name: snapshot_{key}.json */
export function snapshotFileName(intervalKey: string): string {
  return `snapshot_${intervalKey}.json`
}

// MIME types with explicit UTF-8 charset for Google Drive uploads.
// Including charset=utf-8 tells Drive to serve the file with charset metadata,
// giving the browser a correct decoding hint. For downloading, readFile()
// uses fetch + TextDecoder('utf-8') to decode bytes explicitly instead of
// relying on Drive's Content-Type — which may strip charset from custom MIME
// types. Together, these two layers prevent the progressive Chinese-character
// corruption that occurred in the read-modify-write cycle of pushLogs.
const JSON_MIME = 'application/json; charset=utf-8'
const NDJSON_MIME = 'text/plain; charset=utf-8'

/**
 * Check whether a Drive API error is caused by insufficient OAuth scopes
 * (e.g., a token issued before the scope was upgraded from drive.file to drive).
 * If so, clear the stale token so the next auth cycle forces re-consent.
 */
function handleDriveError(err: unknown): never {
  if (err instanceof Error) {
    const msg = err.message || ''
    if (msg.includes('403') || msg.includes('insufficient') || msg.includes('scope')) {
      clearTokenStorage()
    }
  }
  // Check the body for scope-related errors (gapi wraps Drive errors in the message)
  if (typeof err === 'object' && err !== null) {
    const body = String((err as any).body || '')
    if (body.includes('ACCESS_TOKEN_SCOPE_INSUFFICIENT')) {
      clearTokenStorage()
    }
  }
  throw err
}

// ============================================================
// Folder Operations
// ============================================================

/**
 * Find or create the root "记汉字" folder.
 */
export async function findOrCreateRootFolder(): Promise<string> {
  try {
    const token = await getAccessToken()
    setGapiToken(token)

    // Search for existing folder
    const searchResponse = await gapi.client.drive.files.list({
      q: `name = '${ROOT_FOLDER_NAME}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    })

    const files = searchResponse.result.files || []
    if (files.length > 0) {
      return files[0].id!
    }

    // Create new folder
    const createResponse = await gapi.client.drive.files.create({
      resource: {
        name: ROOT_FOLDER_NAME,
        mimeType: 'application/vnd.google-apps.folder',
      },
      fields: 'id',
    })

    return createResponse.result.id!
  } catch (err) {
    handleDriveError(err)
  }
}

/**
 * Find or create a subfolder within a parent folder.
 */
export async function findOrCreateFolder(
  parentId: string,
  folderName: string,
): Promise<string> {
  const token = await getAccessToken()
  setGapiToken(token)

  const searchResponse = await gapi.client.drive.files.list({
    q: `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and '${parentId}' in parents and trashed = false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  })

  const files = searchResponse.result.files || []
  if (files.length > 0) {
    return files[0].id!
  }

  const createResponse = await gapi.client.drive.files.create({
    resource: {
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
  })

  return createResponse.result.id!
}

// ============================================================
// File Operations
// ============================================================

/**
 * Find a file by name within a folder.
 */
export async function findFile(
  folderId: string,
  fileName: string,
): Promise<{ id: string; modifiedTime: string } | null> {
  const token = await getAccessToken()
  setGapiToken(token)

  const response = await gapi.client.drive.files.list({
    q: `name = '${fileName}' and '${folderId}' in parents and trashed = false`,
    fields: 'files(id, modifiedTime)',
    spaces: 'drive',
  })

  const files = response.result.files || []
  if (files.length > 0) {
    return { id: files[0].id!, modifiedTime: files[0].modifiedTime! }
  }
  return null
}

/**
 * List all non-trashed files in a folder.
 * Returns file metadata: id, name, modifiedTime.
 */
export async function listFiles(
  folderId: string,
): Promise<Array<{ id: string; name: string; modifiedTime: string }>> {
  const token = await getAccessToken()
  setGapiToken(token)

  const response = await gapi.client.drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, modifiedTime)',
    spaces: 'drive',
    pageSize: 1000,
  })

  const files = response.result.files || []
  return files.map(f => ({ id: f.id!, name: f.name!, modifiedTime: f.modifiedTime! }))
}

/**
 * Read a file's content from Drive.
 * Uses fetch + explicit UTF-8 decoding instead of gapi.client.drive.files.get.
 * gapi's response.body relies on Google Drive's Content-Type charset — and
 * Drive may strip charset=utf-8 from custom MIME types, causing the browser
 * to decode UTF-8 bytes as Latin-1 (mojibake). By reading raw bytes via
 * fetch and decoding with TextDecoder, we bypass Drive's charset handling
 * entirely and always get correct UTF-8 strings.
 */
export async function readFile(fileId: string): Promise<string> {
  const token = await getAccessToken()

  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
  )

  if (!response.ok) {
    throw new Error(`Failed to read file ${fileId}: HTTP ${response.status}`)
  }

  const buffer = await response.arrayBuffer()
  return new TextDecoder('utf-8').decode(buffer)
}

/**
 * Create or update a file in a folder.
 * If fileId is provided, updates that file. Otherwise creates a new one.
 */
export async function writeFile(
  folderId: string,
  fileName: string,
  content: string,
  mimeType: string = JSON_MIME,
  existingFileId?: string | null,
): Promise<string> {
  const token = await getAccessToken()
  setGapiToken(token)

  if (existingFileId) {
    // Update existing file — simple media upload
    const response = await gapi.client.request({
      path: `/upload/drive/v3/files/${existingFileId}`,
      method: 'PATCH',
      params: { uploadType: 'media' },
      headers: { 'Content-Type': mimeType },
      body: content,
    })
    return existingFileId
  } else {
    // Create new file — multipart upload with metadata + content.
    // gapi.client.request cannot serialize FormData correctly, so we
    // build the multipart body by hand as a string.
    const metadata = { name: fileName, parents: [folderId], mimeType }
    const boundary = `jihanzi_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
    const CRLF = '\r\n'

    const body = [
      `--${boundary}`,
      `Content-Type: ${JSON_MIME}`,
      '',
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      '',
      content,
      `--${boundary}--`,
    ].join(CRLF)

    const response = await gapi.client.request({
      path: '/upload/drive/v3/files',
      method: 'POST',
      params: { uploadType: 'multipart' },
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    })

    return (response.result as { id: string }).id
  }
}

// ============================================================
// High-Level Sync Operations
// ============================================================

/**
 * Pull all data from Google Drive.
 * Returns the app metadata, and per-child snapshots + logs.
 */
export async function pullAllData(): Promise<{
  meta: Record<string, unknown> | null
  childData: Record<string, {
    snapshot: string | null
    historicalSnapshots: Array<{ key: string; data: string }>
    logs: string[]
  }>
}> {
  try {
    const rootId = await findOrCreateRootFolder()

    // Read app_meta.json
    let meta: Record<string, unknown> | null = null
    const metaFile = await findFile(rootId, META_FILE_NAME)
    if (metaFile) {
      try {
        const content = await readFile(metaFile.id)
        meta = JSON.parse(content)
      } catch {
        console.warn('Failed to parse app_meta.json')
      }
    }

    // List child folders
    const token = await getAccessToken()
    setGapiToken(token)

    const childrenResponse = await gapi.client.drive.files.list({
      q: `'${rootId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: 'files(id, name)',
      spaces: 'drive',
    })

    const folders = childrenResponse.result.files || []
    const childData: Record<string, {
      snapshot: string | null
      historicalSnapshots: Array<{ key: string; data: string }>
      logs: string[]
    }> = {}

    for (const folder of folders) {
      const folderName = folder.name!
      const folderId = folder.id!

      // List all files in this child folder
      const allFiles = await listFiles(folderId)

      // ---- Read current snapshot ----
      // Primary: snapshot_current.json (new format)
      // Fallback: snapshot.json (legacy format from older app versions)
      let snapshot: string | null = null
      const currentFile = allFiles.find(f => f.name === SNAPSHOT_CURRENT_FILE_NAME)
      const legacyFile = allFiles.find(f => f.name === SNAPSHOT_LEGACY_FILE_NAME)
      const snapshotFile = currentFile || legacyFile
      if (snapshotFile) {
        try {
          snapshot = await readFile(snapshotFile.id)
        } catch {
          console.warn(`Failed to read snapshot for ${folderName}`)
        }
      }

      // ---- Read historical snapshots ----
      const historicalSnapshots: Array<{ key: string; data: string }> = []
      const snapshotPattern = /^snapshot_(\d{4}-\d{2}-\d{2})\.json$/
      for (const f of allFiles) {
        const match = f.name.match(snapshotPattern)
        if (match) {
          try {
            const data = await readFile(f.id)
            historicalSnapshots.push({ key: match[1], data })
          } catch {
            console.warn(`Failed to read historical snapshot ${f.name} for ${folderName}`)
          }
        }
      }

      // ---- Read all interval-based log files ----
      const logs: string[] = []
      const logPattern = /^log_(\d{4}-\d{2}-\d{2})\.jsonl$/
      for (const f of allFiles) {
        if (logPattern.test(f.name)) {
          try {
            const content = await readFile(f.id)
            logs.push(...content.split('\n').filter(l => l.trim()))
          } catch {
            console.warn(`Failed to read log file ${f.name} for ${folderName}`)
          }
        }
      }

      childData[folderName] = { snapshot, historicalSnapshots, logs }
    }

    return { meta, childData }
  } catch (err) {
    handleDriveError(err)
  }
}

// ============================================================
// Push Operations
// ============================================================

/**
 * Push app metadata to Drive.
 */
export async function pushMeta(
  rootId: string,
  meta: Record<string, unknown>,
  existingFileId?: string | null,
): Promise<string> {
  return writeFile(rootId, META_FILE_NAME, JSON.stringify(meta, null, 2), JSON_MIME, existingFileId)
}

/**
 * Push a snapshot for a child folder.
 * @param snapshotData — JSON string of the snapshot
 * @param existingFileId — update this file instead of creating a new one
 * @param fileName — override the file name (default: snapshot_current.json)
 */
export async function pushSnapshot(
  childFolderId: string,
  snapshotData: string,
  existingFileId?: string | null,
  fileName?: string,
): Promise<string> {
  return writeFile(childFolderId, fileName || SNAPSHOT_CURRENT_FILE_NAME, snapshotData, JSON_MIME, existingFileId)
}

/**
 * Push log entries for a child folder (appends to existing log).
 * @param logEntries — array of serialized JSON log entry strings
 * @param existingFileId — update this file instead of creating a new one
 * @param fileName — override the file name (e.g., log_2026-07-01.jsonl)
 */
export async function pushLogs(
  childFolderId: string,
  logEntries: string[],
  existingFileId?: string | null,
  fileName?: string,
): Promise<string> {
  if (logEntries.length === 0) {
    return existingFileId || ''
  }

  const name = fileName || 'log.jsonl'
  const token = await getAccessToken()
  setGapiToken(token)

  if (existingFileId) {
    // Read existing content once, append all new entries in batch, write once.
    const current = await readFile(existingFileId)
    const normalized = current && !current.endsWith('\n') ? current + '\n' : current
    const updated = normalized + logEntries.join('\n') + '\n'
    return writeFile(childFolderId, name, updated, NDJSON_MIME, existingFileId)
  } else {
    return writeFile(childFolderId, name, logEntries.join('\n') + '\n', NDJSON_MIME)
  }
}
