/**
 * @vitest-environment jsdom
 *
 * Tests for AuthContext — verifies auth state restoration on mount.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import { AuthProvider, useAuth } from './AuthContext'

// Mock gapi module
const {
  mockRestoreToken,
  mockTrySilentLogin,
  mockIsGoogleConfigured,
  mockLoadUserFromStorage,
  mockClearTokenStorage,
  mockGetUserProfile,
} = vi.hoisted(() => ({
  mockRestoreToken: vi.fn(() => false),
  mockTrySilentLogin: vi.fn(() => Promise.resolve(null)),
  mockIsGoogleConfigured: vi.fn(() => false),
  mockLoadUserFromStorage: vi.fn(() => null),
  mockClearTokenStorage: vi.fn(),
  mockGetUserProfile: vi.fn(),
}))

vi.mock('../data/gapi', () => ({
  isGoogleConfigured: () => mockIsGoogleConfigured(),
  initGoogleLibraries: vi.fn().mockResolvedValue(undefined),
  initGapiClient: vi.fn().mockResolvedValue(undefined),
  initTokenClient: vi.fn(),
  requestAccessToken: vi.fn().mockResolvedValue('test-token'),
  signOut: vi.fn(),
  getUserProfile: () => mockGetUserProfile(),
  hasValidToken: () => false,
  restoreToken: () => mockRestoreToken(),
  trySilentLogin: () => mockTrySilentLogin(),
  saveUserToStorage: vi.fn(),
  loadUserFromStorage: () => mockLoadUserFromStorage(),
  clearUserStorage: vi.fn(),
  clearTokenStorage: () => mockClearTokenStorage(),
}))

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(AuthProvider, null, children)
}

describe('AuthContext', () => {
  beforeEach(() => {
    mockRestoreToken.mockReturnValue(false)
    mockTrySilentLogin.mockResolvedValue(null)
    mockIsGoogleConfigured.mockReturnValue(false)
    mockLoadUserFromStorage.mockReturnValue(null)
    mockClearTokenStorage.mockClear()
    mockTrySilentLogin.mockClear()
    mockGetUserProfile.mockReset()
    mockGetUserProfile.mockResolvedValue({
      name: 'Test User',
      email: 'test@example.com',
      picture: 'https://example.com/photo.jpg',
    })
  })

  describe('on mount (demo mode — no Google config)', () => {
    it('finishes loading and stays logged out when no stored auth exists', async () => {
      mockIsGoogleConfigured.mockReturnValue(false)

      const { result } = renderHook(() => useAuth(), { wrapper })

      // After mount effect resolves
      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Not logged in since no stored token in demo mode
      expect(result.current.isLoggedIn).toBe(false)
    })

    it('restores login state from stored user in demo mode', async () => {
      mockIsGoogleConfigured.mockReturnValue(false)
      mockLoadUserFromStorage.mockReturnValue({
        name: 'Stored User',
        email: 'stored@example.com',
        picture: '',
      })

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.isLoggedIn).toBe(true)
      expect(result.current.user).toEqual({
        name: 'Stored User',
        email: 'stored@example.com',
        picture: '',
      })
    })
  })

  describe('on mount (Google configured)', () => {
    it('restores auth when valid token is in localStorage', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(true)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.isLoggedIn).toBe(true)
      expect(result.current.user).toEqual({
        name: 'Test User',
        email: 'test@example.com',
        picture: 'https://example.com/photo.jpg',
      })
    })

    it('does NOT call trySilentLogin when valid token is already restored', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(true)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(result.current.isLoggedIn).toBe(true)
      // Core fix: silent login should be skipped when a valid token exists
      expect(mockTrySilentLogin).not.toHaveBeenCalled()
    })

    it('tries silent refresh when no token in localStorage but stored user exists (returning user)', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(false)
      mockLoadUserFromStorage.mockReturnValue({
        name: 'Returning User',
        email: 'returning@example.com',
        picture: '',
      })
      mockTrySilentLogin.mockResolvedValue('silent-token')

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(mockTrySilentLogin).toHaveBeenCalled()
      expect(result.current.isLoggedIn).toBe(true)
    })

    it('skips silent login when no stored user profile (fresh browser / cleared data)', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(false)
      mockLoadUserFromStorage.mockReturnValue(null) // No previous user
      mockTrySilentLogin.mockResolvedValue('silent-token') // Would succeed if called

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Should NOT attempt silent login — user must explicitly click Login
      expect(mockTrySilentLogin).not.toHaveBeenCalled()
      expect(result.current.isLoggedIn).toBe(false)
    })

    it('stays logged out when both restore and silent refresh fail', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(false)
      mockLoadUserFromStorage.mockReturnValue({
        name: 'Returning User',
        email: 'returning@example.com',
        picture: '',
      })
      mockTrySilentLogin.mockResolvedValue(null)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(mockTrySilentLogin).toHaveBeenCalled()
      expect(result.current.isLoggedIn).toBe(false)
    })

    it('clears invalid token from storage when restored token gets 401 from getUserProfile', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(true) // Token looks valid in localStorage
      mockGetUserProfile.mockRejectedValue(new Error('Failed to get user profile'))

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Must clear the invalid token so next page load doesn't repeat the 401
      expect(mockClearTokenStorage).toHaveBeenCalledTimes(1)
      // Must revert to logged-out state
      expect(result.current.isLoggedIn).toBe(false)
    })
  })

  describe('login', () => {
    it('transitions to logged in state after login()', async () => {
      mockIsGoogleConfigured.mockReturnValue(false)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.login()
      })

      expect(result.current.isLoggedIn).toBe(true)
      expect(result.current.user).toEqual({
        name: '演示用户',
        email: 'demo@example.com',
        picture: '',
      })
    })
  })

  describe('error state', () => {
    it('exposes error when Google API initialization fails', async () => {
      // Make the init chain fail (initGapiClient is the default mock which resolves)
      // We need to simulate the catch path. The easiest way is to make
      // the entire init chain reject — initGoogleLibraries rejects.
      const { initGoogleLibraries } = await import('../data/gapi')
      const mockInitLibs = initGoogleLibraries as ReturnType<typeof vi.fn>
      mockInitLibs.mockRejectedValueOnce(new Error('⛔ Core error code: MissingUrl'))

      mockIsGoogleConfigured.mockReturnValue(true)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Error message should be surfaced
      expect(result.current.error).toBe('⛔ Core error code: MissingUrl')
      expect(result.current.isLoggedIn).toBe(false)
    })

    it('exposes error when login() fails', async () => {
      const { requestAccessToken } = await import('../data/gapi')
      const mockReqToken = requestAccessToken as ReturnType<typeof vi.fn>
      mockReqToken.mockRejectedValueOnce(new Error('⛔ Core error code: MissingUrl'))

      mockIsGoogleConfigured.mockReturnValue(true)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      await act(async () => {
        await result.current.login()
      })

      expect(result.current.error).toBe('⛔ Core error code: MissingUrl')
      expect(result.current.isLoggedIn).toBe(false)
    })

    it('clears error on successful login after a previous error', async () => {
      const { requestAccessToken } = await import('../data/gapi')
      const mockReqToken = requestAccessToken as ReturnType<typeof vi.fn>
      // First call fails
      mockReqToken.mockRejectedValueOnce(new Error('Some error'))
      // Second call succeeds
      mockReqToken.mockResolvedValueOnce('valid-token')

      mockIsGoogleConfigured.mockReturnValue(true)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // First attempt — fails
      await act(async () => {
        await result.current.login()
      })
      expect(result.current.error).toBe('Some error')

      // Second attempt — succeeds
      await act(async () => {
        await result.current.login()
      })
      expect(result.current.error).toBeNull()
      expect(result.current.isLoggedIn).toBe(true)
    })
  })

  describe('logout', () => {
    it('transitions to logged out state after logout()', async () => {
      mockIsGoogleConfigured.mockReturnValue(false)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      // Login first
      await act(async () => {
        await result.current.login()
      })
      expect(result.current.isLoggedIn).toBe(true)

      // Then logout
      act(() => {
        result.current.logout()
      })

      expect(result.current.isLoggedIn).toBe(false)
      expect(result.current.user).toBeNull()
    })
  })
})
