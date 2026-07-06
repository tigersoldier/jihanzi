/**
 * Tests for gapi.ts localStorage token persistence.
 *
 * Uses a mock localStorage since jsdom in vitest 4.x doesn't provide it globally.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock google global + env vars for trySilentLogin tests.
// vi.hoisted runs before module evaluation, so imports from './gapi'
// see the mocked globals.
const { mockRequestAccessToken } = vi.hoisted(() => {
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', 'test-client-id')
  vi.stubEnv('VITE_GOOGLE_API_KEY', 'test-api-key')

  const mockTC = {
    callback: null as any,
    requestAccessToken: vi.fn(),
  }

  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: vi.fn(() => mockTC),
        revoke: vi.fn(),
      },
    },
  })

  return { mockRequestAccessToken: mockTC.requestAccessToken }
})

// Override isGoogleConfigured so trySilentLogin doesn't bail out early.
// All other exports are the real implementations via importActual.
vi.mock('./gapi', async () => {
  const actual = await vi.importActual<typeof import('./gapi')>('./gapi')
  return { ...actual, isGoogleConfigured: () => true }
})

// Create a mock localStorage
const store = new Map<string, string>()
const mockLocalStorage = {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { store.set(key, value) }),
  removeItem: vi.fn((key: string) => { store.delete(key) }),
  clear: vi.fn(() => { store.clear() }),
}
vi.stubGlobal('localStorage', mockLocalStorage)

// Import after mock is installed so the module uses our mock
import {
  saveTokenToStorage,
  loadTokenFromStorage,
  clearTokenStorage,
  saveUserToStorage,
  loadUserFromStorage,
  clearUserStorage,
  restoreToken,
  hasValidToken,
  initTokenClient,
  trySilentLogin,
  isGoogleConfigured,
} from './gapi'

const STORAGE_KEY_TOKEN = 'jihanzi_auth_token'
const STORAGE_KEY_EXPIRY = 'jihanzi_auth_expiry'
const STORAGE_KEY_USER = 'jihanzi_auth_user'

describe('gapi localStorage persistence', () => {
  beforeEach(() => {
    store.clear()
    vi.clearAllMocks()
  })

  describe('saveTokenToStorage / loadTokenFromStorage', () => {
    it('saves and loads token and expiry', () => {
      const token = 'test-access-token-123'
      const expiry = Date.now() + 3600000

      saveTokenToStorage(token, expiry)
      const result = loadTokenFromStorage()

      expect(result).not.toBeNull()
      expect(result!.token).toBe(token)
      expect(result!.expiry).toBe(expiry)
    })

    it('returns null when no token is stored', () => {
      const result = loadTokenFromStorage()
      expect(result).toBeNull()
    })

    it('returns null when only token is stored without expiry', () => {
      store.set(STORAGE_KEY_TOKEN, 'some-token')
      const result = loadTokenFromStorage()
      expect(result).toBeNull()
    })

    it('returns null when only expiry is stored without token', () => {
      store.set(STORAGE_KEY_EXPIRY, '12345')
      const result = loadTokenFromStorage()
      expect(result).toBeNull()
    })
  })

  describe('clearTokenStorage', () => {
    it('removes token and expiry from localStorage', () => {
      saveTokenToStorage('token', Date.now() + 1000)
      clearTokenStorage()

      expect(store.get(STORAGE_KEY_TOKEN)).toBeUndefined()
      expect(store.get(STORAGE_KEY_EXPIRY)).toBeUndefined()
    })

    it('is idempotent — does not throw when nothing is stored', () => {
      expect(() => clearTokenStorage()).not.toThrow()
    })
  })

  describe('saveUserToStorage / loadUserFromStorage', () => {
    it('saves and loads user profile', () => {
      const user = { name: 'Test User', email: 'test@example.com', picture: 'https://example.com/photo.jpg' }
      saveUserToStorage(user)
      const result = loadUserFromStorage()

      expect(result).toEqual(user)
    })

    it('returns null when no user is stored', () => {
      expect(loadUserFromStorage()).toBeNull()
    })

    it('returns null for malformed JSON', () => {
      store.set(STORAGE_KEY_USER, 'not valid json{{{')
      expect(loadUserFromStorage()).toBeNull()
    })
  })

  describe('clearUserStorage', () => {
    it('removes user from localStorage', () => {
      saveUserToStorage({ name: 'X', email: 'x@x.com', picture: '' })
      clearUserStorage()
      expect(store.get(STORAGE_KEY_USER)).toBeUndefined()
    })
  })

  describe('restoreToken', () => {
    it('returns true and restores valid token from storage', () => {
      const token = 'valid-token'
      const expiry = Date.now() + 3600000 // 1 hour from now
      saveTokenToStorage(token, expiry)

      const result = restoreToken()

      expect(result).toBe(true)
      // Verify the token is now valid via hasValidToken
      expect(hasValidToken()).toBe(true)
    })

    it('returns false when no token is stored', () => {
      expect(restoreToken()).toBe(false)
    })

    it('returns false when stored token is expired', () => {
      const token = 'expired-token'
      const expiry = Date.now() - 1000 // 1 second ago
      saveTokenToStorage(token, expiry)

      expect(restoreToken()).toBe(false)
    })

    it('returns false when token is about to expire (within 60s)', () => {
      const token = 'almost-expired-token'
      const expiry = Date.now() + 30000 // 30 seconds from now
      saveTokenToStorage(token, expiry)

      expect(restoreToken()).toBe(false)
    })

    // With custom buffer parameter
    it('restoreToken() without arguments defaults to 60000ms buffer', () => {
      const token = 'token-90s'
      const expiry = Date.now() + 90000 // 90 seconds from now — within default 60s? No, 90s > 60s
      saveTokenToStorage(token, expiry)

      // 90s > 60s default buffer, so token is valid
      expect(restoreToken()).toBe(true)
    })

    it('restoreToken(180000) with 3-min buffer rejects token expiring in 2 minutes', () => {
      const token = 'token-2min'
      const expiry = Date.now() + 120000 // 2 minutes from now
      saveTokenToStorage(token, expiry)

      // 120s < 180s buffer, so token is "too close to expiry" — rejected
      expect(restoreToken(180000)).toBe(false)
    })

    it('restoreToken(300000) with 5-min buffer accepts token expiring in 10 minutes', () => {
      const token = 'token-10min'
      const expiry = Date.now() + 600000 // 10 minutes from now
      saveTokenToStorage(token, expiry)

      // 600s > 300s buffer, so token is valid
      expect(restoreToken(300000)).toBe(true)
    })

    it('restoreToken(60000) rejects token exactly at buffer boundary (59s from expiry)', () => {
      const token = 'token-59s'
      const expiry = Date.now() + 59000 // 59 seconds from now — just inside 60s buffer
      saveTokenToStorage(token, expiry)

      // Strictly less-than: 59000 < 60000, should NOT be valid
      expect(restoreToken(60000)).toBe(false)
    })

    it('restoreToken(60000) accepts token just past buffer boundary (61s from expiry)', () => {
      const token = 'token-61s'
      const expiry = Date.now() + 61000 // 61 seconds from now — just outside 60s buffer
      saveTokenToStorage(token, expiry)

      // Strictly less-than: 61000 > 60000, should be valid
      expect(restoreToken(60000)).toBe(true)
    })
  })

  describe('hasValidToken', () => {
    it('hasValidToken() defaults to 60000ms buffer', () => {
      const expiry = Date.now() + 90000 // 90s from now — > 60s default buffer
      saveTokenToStorage('token-90s', expiry)
      restoreToken(0) // Load into memory (0 buffer accepts anything not expired)

      expect(hasValidToken()).toBe(true)
    })

    it('hasValidToken(180000) rejects token expiring in 2 minutes', () => {
      const expiry = Date.now() + 120000 // 2 minutes from now
      saveTokenToStorage('token-2min', expiry)
      restoreToken(0)

      expect(hasValidToken(180000)).toBe(false)
    })

    it('hasValidToken(300000) accepts token expiring in 10 minutes', () => {
      const expiry = Date.now() + 600000 // 10 minutes from now
      saveTokenToStorage('token-10min', expiry)
      restoreToken(0)

      expect(hasValidToken(300000)).toBe(true)
    })
  })

  describe('trySilentLogin', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      store.clear()
      mockRequestAccessToken.mockClear()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('resolves to null after 3s timeout when Google callback never fires', async () => {
      // Given: token client is initialized
      initTokenClient()

      // When: trySilentLogin is called (no Google session → callback never fires)
      const promise = trySilentLogin()

      // Then: after 3s timeout, it should resolve to null (not hang forever)
      vi.advanceTimersByTime(3500)
      const result = await promise

      expect(result).toBeNull()
      // Verify the silent request was made with prompt: ''
      expect(mockRequestAccessToken).toHaveBeenCalledWith({ prompt: '' })
    })

    it('resolves to token when Google callback fires with access_token', async () => {
      initTokenClient()

      // Simulate callback firing synchronously
      const mockTokenClient = (google.accounts.oauth2.initTokenClient as ReturnType<typeof vi.fn>).mock.results[0].value
      mockTokenClient.callback = vi.fn()

      // Mock requestAccessToken to invoke the callback with a token
      mockRequestAccessToken.mockImplementationOnce(() => {
        mockTokenClient.callback({
          access_token: 'silent-token-123',
          expires_in: '3600',
        })
      })

      const promise = trySilentLogin()
      const result = await promise

      expect(result).toBe('silent-token-123')
    })

    it('resolves to null when Google callback fires with error', async () => {
      initTokenClient()

      const mockTokenClient = (google.accounts.oauth2.initTokenClient as ReturnType<typeof vi.fn>).mock.results[0].value
      mockTokenClient.callback = vi.fn()

      mockRequestAccessToken.mockImplementationOnce(() => {
        mockTokenClient.callback({
          error: 'popup_closed_by_user',
        })
      })

      const promise = trySilentLogin()
      const result = await promise

      expect(result).toBeNull()
    })
  })
})
