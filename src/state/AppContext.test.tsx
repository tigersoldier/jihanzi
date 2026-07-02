/**
 * @vitest-environment jsdom
 *
 * Tests for AppContext — verifies sync is triggered after data mutations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import { AppProvider, useApp } from './AppContext'
import { AuthProvider } from './AuthContext'

// We test that AppContext triggers sync after mutations.
// Mock sync module to intercept pushChanges calls.
const { mockNotifyDataChanged } = vi.hoisted(() => ({
  mockNotifyDataChanged: vi.fn(),
}))

vi.mock('../data/sync', () => ({
  pushChanges: vi.fn(),
  notifyDataChanged: () => mockNotifyDataChanged(),
  getSyncStatus: () => 'online',
  onSyncStatusChange: vi.fn().mockReturnValue(() => {}),
  startBackgroundSync: vi.fn(),
  stopBackgroundSync: vi.fn(),
  checkOnlineStatus: vi.fn(),
  initialPull: vi.fn().mockResolvedValue(undefined),
  SyncStatus: {},
}))

// Mock gapi
vi.mock('../data/gapi', () => ({
  isGoogleConfigured: () => false,
  initGoogleLibraries: vi.fn(),
  initGapiClient: vi.fn(),
  initTokenClient: vi.fn(),
  requestAccessToken: vi.fn(),
  signOut: vi.fn(),
  getUserProfile: vi.fn(),
  hasValidToken: () => false,
  restoreToken: () => false,
  trySilentLogin: () => Promise.resolve(null),
  saveUserToStorage: vi.fn(),
  loadUserFromStorage: () => null,
  clearUserStorage: vi.fn(),
  saveTokenToStorage: vi.fn(),
  loadTokenFromStorage: () => null,
  clearTokenStorage: vi.fn(),
}))

// Mock db
vi.mock('../data/db', () => ({
  appendLog: vi.fn().mockResolvedValue(undefined),
  appendLogs: vi.fn().mockResolvedValue(undefined),
  getAllLogs: vi.fn().mockResolvedValue([]),
  getLatestSnapshot: vi.fn().mockResolvedValue(null),
  saveSnapshot: vi.fn().mockResolvedValue(undefined),
  getLastSyncTime: vi.fn().mockResolvedValue(null),
  setLastSyncTime: vi.fn(),
  deleteLogsBefore: vi.fn(),
}))

function wrapper({ children }: { children: ReactNode }) {
  return React.createElement(AuthProvider, null,
    React.createElement(AppProvider, null, children),
  )
}

describe('AppContext — sync triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('triggers sync after bulkImport', async () => {
    const { result } = renderHook(() => useApp(), {
      wrapper,
      // AuthProvider starts with isLoading=true, wait for demo mode
    })

    // Wait for auth to resolve (demo mode sets isLoading=false immediately)
    await vi.waitFor(() => {
      // AppProvider's loadState will run after isLoggedIn becomes true
    }, { timeout: 1000 })

    const snapshot = {
      timestamp: Date.now(),
      state: {
        children: [{ id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} }],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二', '三'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    const logs: any[] = []

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    // After bulkImport, notifyDataChanged should have been called
    expect(mockNotifyDataChanged).toHaveBeenCalledTimes(1)
  })

  it('exposes reloadState as a callable function', async () => {
    const { result } = renderHook(() => useApp(), { wrapper })

    await vi.waitFor(() => {
      // Wait for auth + initial load
    }, { timeout: 1000 })

    expect(typeof result.current.reloadState).toBe('function')
    // Calling reloadState should not throw
    expect(() => result.current.reloadState()).not.toThrow()
  })
})
