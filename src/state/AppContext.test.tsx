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
  notifyDataChanged: () => mockNotifyDataChanged(),
  getSyncStatus: () => 'online',
  onSyncStatusChange: vi.fn().mockReturnValue(() => {}),
  startBackgroundSync: vi.fn(),
  stopBackgroundSync: vi.fn(),
  checkOnlineStatus: vi.fn(),
  initialPull: vi.fn().mockResolvedValue({
    didMerge: false,
    driveIsEmpty: true,
    remoteSnapshot: null,
    remoteLogEntries: [],
  }),
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

// Mock db with state accumulation so applyAndPersist can read the latest snapshot
const { mockTransaction, mockGetLatestSnapshot, mockSaveCurrentSnapshot } = vi.hoisted(() => {
  let savedSnapshot: { timestamp: number; state: any } | null = null

  return {
    mockTransaction: vi.fn((...args: unknown[]) => {
      const fn = args[args.length - 1] as () => Promise<void>
      return fn()
    }),
    mockGetLatestSnapshot: vi.fn(async () => savedSnapshot),
    mockSaveCurrentSnapshot: vi.fn(async (snap: { timestamp: number; state: any }) => {
      savedSnapshot = snap
    }),
  }
})

vi.mock('../data/db', () => ({
  default: {
    transaction: mockTransaction,
    logs: {},
    snapshot: {},
    meta: {},
  },
  appendLog: vi.fn().mockResolvedValue(undefined),
  appendLogs: vi.fn().mockResolvedValue(undefined),
  getLatestSnapshot: mockGetLatestSnapshot,
  saveCurrentSnapshot: mockSaveCurrentSnapshot,
  saveHistoricalSnapshot: vi.fn().mockResolvedValue(undefined),
  pruneOldSnapshots: vi.fn().mockResolvedValue(undefined),
  getLogCount: vi.fn().mockResolvedValue(0),
  pruneOldestLogs: vi.fn().mockResolvedValue(0),
  getLastKnownRemoteTime: vi.fn().mockResolvedValue(0),
  setLastKnownRemoteTime: vi.fn(),
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

  it('IndexedDB 写入失败时 submitReview 传播错误且不更新 state', async () => {
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

    // Setup: create wordbook + child
    let wbId = ''
    let childId = ''
    await act(async () => {
      wbId = await result.current.app.createWordBook('测试生字本', ['一'])
      childId = await result.current.app.createChild('小明', wbId)
    })

    // Make appendLog throw — the Dexie transaction will fail and error propagates
    const { appendLog } = await import('../data/db')
    const mockAppendLog = appendLog as ReturnType<typeof vi.fn>
    mockAppendLog.mockRejectedValueOnce(new Error('IndexedDB write failed'))

    // submitReview should reject because the transaction failed
    await expect(
      result.current.app.submitReview(childId, '一', 'a', 1, '2026-07-01')
    ).rejects.toThrow('IndexedDB write failed')

    // State should NOT have the failed review
    {
      const child = result.current.app.state.children.find(c => c.id === childId)!
      expect(child.progress['一']).toBeUndefined()
    }
  })
})
