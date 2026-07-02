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
} = vi.hoisted(() => ({
  mockRestoreToken: vi.fn(() => false),
  mockTrySilentLogin: vi.fn(() => Promise.resolve(null)),
  mockIsGoogleConfigured: vi.fn(() => false),
  mockLoadUserFromStorage: vi.fn(() => null),
}))

vi.mock('../data/gapi', () => ({
  isGoogleConfigured: () => mockIsGoogleConfigured(),
  initGoogleLibraries: vi.fn().mockResolvedValue(undefined),
  initGapiClient: vi.fn().mockResolvedValue(undefined),
  initTokenClient: vi.fn(),
  requestAccessToken: vi.fn().mockResolvedValue('test-token'),
  signOut: vi.fn(),
  getUserProfile: vi.fn().mockResolvedValue({
    name: 'Test User',
    email: 'test@example.com',
    picture: 'https://example.com/photo.jpg',
  }),
  hasValidToken: () => false,
  restoreToken: () => mockRestoreToken(),
  trySilentLogin: () => mockTrySilentLogin(),
  saveUserToStorage: vi.fn(),
  loadUserFromStorage: () => mockLoadUserFromStorage(),
  clearUserStorage: vi.fn(),
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

    it('tries silent refresh when no token in localStorage but token restore fails', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(false)
      mockTrySilentLogin.mockResolvedValue('silent-token')

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(mockTrySilentLogin).toHaveBeenCalled()
      expect(result.current.isLoggedIn).toBe(true)
    })

    it('stays logged out when both restore and silent refresh fail', async () => {
      mockIsGoogleConfigured.mockReturnValue(true)
      mockRestoreToken.mockReturnValue(false)
      mockTrySilentLogin.mockResolvedValue(null)

      const { result } = renderHook(() => useAuth(), { wrapper })

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false)
      })

      expect(mockTrySilentLogin).toHaveBeenCalled()
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
