/**
 * @vitest-environment jsdom
 *
 * Tests for AppContext — verifies sync is triggered after data mutations.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import { AppProvider, useApp } from './AppContext'
import { AuthProvider, useAuth } from './AuthContext'
import { getChildStats } from '../core/scheduler'

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

  it('submitReview 后 child.progress 包含已评字符，已学字数增加', async () => {
    // Use a combined hook that gives us both auth and app context
    function useCombined() {
      const auth = useAuth()
      const app = useApp()
      return { auth, app }
    }
    const { result } = renderHook(() => useCombined(), { wrapper })

    // Login first (demo mode) — this sets isLoggedIn=true which triggers
    // AppProvider's initial loadState from IndexedDB.
    await act(async () => {
      await result.current.auth.login()
    })

    // Wait for AppProvider's async loadState to finish
    await vi.waitFor(() => {
      expect(result.current.app.loading).toBe(false)
    }, { timeout: 2000 })

    // Create a wordbook with some characters
    let wbId = ''
    await act(async () => {
      wbId = await result.current.app.createWordBook('测试生字本', ['一', '二', '三'])
    })

    // Create a child using that wordbook
    let childId = ''
    await act(async () => {
      childId = await result.current.app.createChild('小明', wbId)
    })

    // Before review: progress should be empty, stats.total should be 0
    {
      const child = result.current.app.state.children.find(c => c.id === childId)!
      expect(child).toBeDefined()
      const statsBefore = getChildStats(child)
      expect(statsBefore.total).toBe(0)
    }

    // Submit a review for a new character (round 1)
    await act(async () => {
      await result.current.app.submitReview(childId, '一', 'a', 1, '2026-07-01')
    })

    // After review: '一' should be in child.progress, stats.total should be 1
    {
      const child = result.current.app.state.children.find(c => c.id === childId)!
      expect(child.progress['一']).toBeDefined()
      expect(child.progress['一'].lastGrade).toBe('a')
      const statsAfter = getChildStats(child)
      expect(statsAfter.total).toBe(1)
    }
  })

  it('IndexedDB 写入失败时 submitReview 仍然乐观更新 state', async () => {
    function useCombined() {
      const auth = useAuth()
      const app = useApp()
      return { auth, app }
    }
    const { result } = renderHook(() => useCombined(), { wrapper })

    await act(async () => {
      await result.current.auth.login()
    })

    await vi.waitFor(() => {
      expect(result.current.app.loading).toBe(false)
    }, { timeout: 2000 })

    // Setup: create wordbook + child (these use appendLog successfully)
    let wbId = ''
    let childId = ''
    await act(async () => {
      wbId = await result.current.app.createWordBook('测试生字本', ['一'])
      childId = await result.current.app.createChild('小明', wbId)
    })

    // Now make appendLog throw — only affects the next submitReview call
    const { appendLog } = await import('../data/db')
    const mockAppendLog = appendLog as ReturnType<typeof vi.fn>
    mockAppendLog.mockRejectedValueOnce(new Error('IndexedDB write failed'))

    // Submit a review — appendLog will reject, but state should still be
    // updated optimistically because the try/catch in submitReview prevents
    // the error from propagating
    await act(async () => {
      await result.current.app.submitReview(childId, '一', 'a', 1, '2026-07-01')
    })

    // State should still reflect the review even though IndexedDB failed
    {
      const child = result.current.app.state.children.find(c => c.id === childId)!
      expect(child.progress['一']).toBeDefined()
      expect(child.progress['一'].lastGrade).toBe('a')
      const statsAfter = getChildStats(child)
      expect(statsAfter.total).toBe(1)
    }
  })
})
