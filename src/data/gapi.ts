/**
 * Google API Initialization & Authentication
 *
 * Uses Google Identity Services for OAuth and gapi for Drive API.
 * Pure frontend flow — no backend required.
 */

// Google Cloud Console configuration
// These should be configured by the user for their own Google Cloud project
const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''
const GOOGLE_API_KEY = import.meta.env.VITE_GOOGLE_API_KEY || ''
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const DRIVE_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'

let tokenClient: google.accounts.oauth2.TokenClient | null = null
let accessToken: string | null = null
let tokenExpiry: number = 0

/**
 * Load the Google API client library (gapi).
 * Must be called once before any Drive operations.
 */
export function loadGapiScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://apis.google.com/js/api.js'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google API script'))
    document.head.appendChild(script)
  })
}

/**
 * Load the Google Identity Services (GIS) library.
 */
export function loadGisScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://accounts.google.com/gsi/client'
    script.async = true
    script.defer = true
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script'))
    document.head.appendChild(script)
  })
}

/**
 * Initialize both gapi and GIS libraries.
 */
export async function initGoogleLibraries(): Promise<void> {
  await loadGapiScript()
  await loadGisScript()
}

/**
 * Initialize the gapi client with API key and discovery docs.
 */
export async function initGapiClient(): Promise<void> {
  return new Promise((resolve, reject) => {
    gapi.load('client', async () => {
      try {
        await gapi.client.init({
          apiKey: GOOGLE_API_KEY,
          discoveryDocs: [DRIVE_DISCOVERY_DOC],
        })
        resolve()
      } catch (err) {
        reject(err)
      }
    })
  })
}

/**
 * Initialize the token client for OAuth.
 */
export function initTokenClient(): void {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (response) => {
      if (response.error) {
        console.error('OAuth error:', response.error)
        return
      }
      accessToken = response.access_token
      tokenExpiry = Date.now() + (parseInt(response.expires_in || '3600') * 1000)
    },
  })
  tokenClient = client
}

/**
 * Request an access token from the user.
 * This will show the Google sign-in popup.
 */
export async function requestAccessToken(): Promise<string> {
  if (!tokenClient) {
    throw new Error('Token client not initialized')
  }

  return new Promise((resolve, reject) => {
    tokenClient!.callback = (response) => {
      if (response.error) {
        reject(new Error(`OAuth error: ${response.error}`))
        return
      }
      accessToken = response.access_token
      tokenExpiry = Date.now() + (parseInt(response.expires_in || '3600') * 1000)
      resolve(accessToken!)
    }
    tokenClient!.requestAccessToken()
  })
}

/**
 * Get a valid access token, refreshing if needed.
 */
export async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry - 60000) {
    return accessToken
  }
  return requestAccessToken()
}

/**
 * Set the access token on gapi client.
 */
export function setGapiToken(token: string): void {
  gapi.client.setToken({ access_token: token })
}

/**
 * Check if we have a valid token.
 */
export function hasValidToken(): boolean {
  return accessToken !== null && Date.now() < tokenExpiry - 60000
}

/**
 * Get the current user's profile info.
 */
export async function getUserProfile(): Promise<{ name: string; email: string; picture: string }> {
  const token = await getAccessToken()
  const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!response.ok) {
    throw new Error('Failed to get user profile')
  }
  return response.json()
}

/**
 * Sign out: revoke token and clear state.
 */
export function signOut(): void {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {})
  }
  accessToken = null
  tokenExpiry = 0
  tokenClient = null
}

/**
 * Check if Google APIs are configured.
 */
export function isGoogleConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== '' && GOOGLE_API_KEY !== ''
}
