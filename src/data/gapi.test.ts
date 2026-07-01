/**
 * Tests for gapi.ts localStorage token persistence.
 *
 * Uses a mock localStorage since jsdom in vitest 4.x doesn't provide it globally.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

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
  })
})
