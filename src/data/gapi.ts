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

// localStorage keys
const STORAGE_KEY_TOKEN = 'jihanzi_auth_token'
const STORAGE_KEY_EXPIRY = 'jihanzi_auth_expiry'
const STORAGE_KEY_USER = 'jihanzi_auth_user'

let tokenClient: google.accounts.oauth2.TokenClient | null = null
let accessToken: string | null = null
let tokenExpiry: number = 0

/**
 * Persist token and expiry to localStorage.
 */
export function saveTokenToStorage(token: string, expiry: number): void {
  try {
    localStorage.setItem(STORAGE_KEY_TOKEN, token)
    localStorage.setItem(STORAGE_KEY_EXPIRY, String(expiry))
  } catch {
    // localStorage may be unavailable in some environments
  }
}

/**
 * Load token and expiry from localStorage.
 * Returns null if no valid stored data exists.
 */
export function loadTokenFromStorage(): { token: string; expiry: number } | null {
  try {
    const token = localStorage.getItem(STORAGE_KEY_TOKEN)
    const expiry = localStorage.getItem(STORAGE_KEY_EXPIRY)
    if (token && expiry) {
      return { token, expiry: parseInt(expiry, 10) }
    }
  } catch {
    // localStorage may be unavailable
  }
  return null
}

/**
 * Remove token and expiry from localStorage.
 */
export function clearTokenStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_TOKEN)
    localStorage.removeItem(STORAGE_KEY_EXPIRY)
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Persist user profile to localStorage.
 */
export function saveUserToStorage(user: { name: string; email: string; picture: string }): void {
  try {
    localStorage.setItem(STORAGE_KEY_USER, JSON.stringify(user))
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Load user profile from localStorage.
 * Returns null if no stored profile exists or parsing fails.
 */
export function loadUserFromStorage(): { name: string; email: string; picture: string } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_USER)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Remove user profile from localStorage.
 */
export function clearUserStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY_USER)
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Restore token from localStorage into module variables.
 * Returns true if a valid (non-expired) token was restored.
 */
export function restoreToken(): boolean {
  const stored = loadTokenFromStorage()
  if (stored && Date.now() < stored.expiry - 60000) {
    accessToken = stored.token
    tokenExpiry = stored.expiry
    return true
  }
  return false
}

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
      saveTokenToStorage(accessToken!, tokenExpiry)
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
      saveTokenToStorage(accessToken!, tokenExpiry)
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
  clearTokenStorage()
}

/**
 * Attempt a silent token refresh using Google Identity Services.
 * Uses prompt: '' which returns a token without showing any UI —
 * only succeeds if the user has a valid Google session cookie.
 * Returns the access token on success, or null on failure.
 */
export async function trySilentLogin(): Promise<string | null> {
  if (!tokenClient || !isGoogleConfigured()) {
    return null
  }

  try {
    return await new Promise<string | null>((resolve) => {
      // Save original callback
      const originalCallback = tokenClient!.callback

      tokenClient!.callback = (response) => {
        if (response.error) {
          resolve(null)
          return
        }
        accessToken = response.access_token
        tokenExpiry = Date.now() + (parseInt(response.expires_in || '3600') * 1000)
        saveTokenToStorage(accessToken!, tokenExpiry)
        resolve(accessToken!)
      }

      ;(tokenClient!.requestAccessToken as (config?: { prompt: string }) => void)({ prompt: '' })

      // Restore original callback after a timeout in case the
      // silent request never completes (e.g., no Google session)
      setTimeout(() => {
        // If the callback hasn't fired yet, resolve null silently
        // and restore the original callback
        if (tokenClient) {
          tokenClient.callback = originalCallback
        }
      }, 3000)
    })
  } catch {
    return null
  }
}

/**
 * Check if Google APIs are configured.
 */
export function isGoogleConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== '' && GOOGLE_API_KEY !== ''
}
