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

import { getAccessToken, setGapiToken } from './gapi'

const ROOT_FOLDER_NAME = '记汉字'
const META_FILE_NAME = 'app_meta.json'
const SNAPSHOT_FILE_NAME = 'snapshot.json'
const LOG_FILE_NAME = 'log.jsonl'

// ============================================================
// Folder Operations
// ============================================================

/**
 * Find or create the root "记汉字" folder.
 */
export async function findOrCreateRootFolder(): Promise<string> {
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
 * Read a file's content from Drive.
 */
export async function readFile(fileId: string): Promise<string> {
  const token = await getAccessToken()
  setGapiToken(token)

  const response = await gapi.client.drive.files.get({
    fileId,
    alt: 'media',
  })

  return response.body as string
}

/**
 * Create or update a file in a folder.
 * If fileId is provided, updates that file. Otherwise creates a new one.
 */
export async function writeFile(
  folderId: string,
  fileName: string,
  content: string,
  mimeType: string = 'application/json',
  existingFileId?: string | null,
): Promise<string> {
  const token = await getAccessToken()
  setGapiToken(token)

  if (existingFileId) {
    // Update existing file
    const response = await gapi.client.request({
      path: `/upload/drive/v3/files/${existingFileId}`,
      method: 'PATCH',
      params: { uploadType: 'media' },
      body: content,
    })
    return existingFileId
  } else {
    // Create new file
    const metadata = {
      name: fileName,
      parents: [folderId],
      mimeType,
    }

    const form = new FormData()
    form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }))
    form.append('file', new Blob([content], { type: mimeType }))

    const response = await gapi.client.request({
      path: '/upload/drive/v3/files',
      method: 'POST',
      params: { uploadType: 'multipart' },
      body: form,
    })

    return (response.result as { id: string }).id
  }
}

/**
 * Append a line to a log file on Drive.
 * For .jsonl files, we append a line with the log entry.
 */
export async function appendToLogFile(
  folderId: string,
  entry: string,
  existingFileId?: string | null,
): Promise<string> {
  const token = await getAccessToken()
  setGapiToken(token)

  if (existingFileId) {
    // For Drive, we need to read-modify-write since there's no real append
    const current = await readFile(existingFileId)
    const updated = current + entry + '\n'
    return writeFile(folderId, LOG_FILE_NAME, updated, 'application/x-ndjson', existingFileId)
  } else {
    return writeFile(folderId, LOG_FILE_NAME, entry + '\n', 'application/x-ndjson')
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
  childData: Record<string, { snapshot: string | null; logs: string[] }>
}> {
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
  const childData: Record<string, { snapshot: string | null; logs: string[] }> = {}

  for (const folder of folders) {
    const folderName = folder.name!
    const folderId = folder.id!

    // Read snapshot
    let snapshot: string | null = null
    const snapshotFile = await findFile(folderId, SNAPSHOT_FILE_NAME)
    if (snapshotFile) {
      try {
        snapshot = await readFile(snapshotFile.id)
      } catch {
        console.warn(`Failed to read snapshot for ${folderName}`)
      }
    }

    // Read log
    const logs: string[] = []
    const logFile = await findFile(folderId, LOG_FILE_NAME)
    if (logFile) {
      try {
        const content = await readFile(logFile.id)
        logs.push(...content.split('\n').filter(l => l.trim()))
      } catch {
        console.warn(`Failed to read log for ${folderName}`)
      }
    }

    childData[folderName] = { snapshot, logs }
  }

  return { meta, childData }
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
  return writeFile(rootId, META_FILE_NAME, JSON.stringify(meta, null, 2), 'application/json', existingFileId)
}

/**
 * Push a snapshot for a child folder.
 */
export async function pushSnapshot(
  childFolderId: string,
  snapshotData: string,
  existingFileId?: string | null,
): Promise<string> {
  return writeFile(childFolderId, SNAPSHOT_FILE_NAME, snapshotData, 'application/json', existingFileId)
}

/**
 * Push log entries for a child folder (appends to existing log).
 */
export async function pushLogs(
  childFolderId: string,
  logEntries: string[],
  existingFileId?: string | null,
): Promise<string> {
  let fileId = existingFileId
  for (const entry of logEntries) {
    fileId = await appendToLogFile(childFolderId, entry, fileId)
  }
  return fileId!
}
