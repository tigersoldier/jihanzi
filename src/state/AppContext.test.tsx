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

vi.mock('../data/sync', async () => {
  // 复用真实的 repairSnapshotProgress / salvageUnverifiableHeavy，
  // 只拦截同步触发函数
  const actual = await vi.importActual<typeof import('../data/sync')>('../data/sync')
  return {
    ...actual,
    notifyDataChanged: () => mockNotifyDataChanged(),
  }
})

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
const { mockTransaction, mockGetLatestSnapshot, mockSaveCurrentSnapshot, mockAppendLogs } =
  vi.hoisted(() => {
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
      mockAppendLogs: vi.fn().mockResolvedValue(undefined),
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
  appendLogs: mockAppendLogs,
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
  return React.createElement(AuthProvider, null, React.createElement(AppProvider, null, children))
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
    await vi.waitFor(
      () => {
        // AppProvider's loadState will run after isLoggedIn becomes true
      },
      { timeout: 1000 },
    )

    const snapshot = {
      timestamp: Date.now(),
      state: {
        children: [
          { id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} },
        ],
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

    await vi.waitFor(
      () => {
        // Wait for auth + initial load
      },
      { timeout: 1000 },
    )

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
    await vi.waitFor(
      () => {
        expect(result.current.app.loading).toBe(false)
      },
      { timeout: 2000 },
    )

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

    await vi.waitFor(
      () => {
        expect(result.current.app.loading).toBe(false)
      },
      { timeout: 2000 },
    )

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
      result.current.app.submitReview(childId, '一', 'a', 1, '2026-07-01'),
    ).rejects.toThrow('IndexedDB write failed')

    // State should NOT have the failed review
    {
      const child = result.current.app.state.children.find(c => c.id === childId)!
      expect(child.progress['一']).toBeUndefined()
    }
  })
})

describe('bulkImport — 快照为准，只重放快照之后的日志', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function renderWithBulkImport() {
    const { result } = renderHook(() => useApp(), { wrapper })
    await vi.waitFor(
      () => {
        expect(result.current.bulkImport).toBeDefined()
      },
      { timeout: 1000 },
    )
    return result
  }

  it('导入完整快照+日志时不重复计算学习次数（回归：途字 3 次被算成 6 次、interval 595 天）', async () => {
    const result = await renderWithBulkImport()

    // 用户真实场景：快照已物化 '途' 的 3 次学习（reps=3, interval=22），
    // 日志中同样是这 3 条 review（timestamp 均早于快照时间戳）
    const snapshot = {
      timestamp: 1785564867246,
      state: {
        children: [
          {
            id: 'child_1',
            name: '陈尚恩',
            wordBookId: 'wb_1',
            nextCharIndex: 2,
            progress: {
              途: {
                ease: 2.8,
                interval: 22,
                repetitions: 3,
                nextReview: '2026-08-18',
                lastGrade: 'a',
                firstReviewDay: '2026-07-08',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '途'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    const logs = [
      {
        timestamp: 1783566656274,
        type: 'review',
        childId: 'child_1',
        character: '途',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-08',
      },
      {
        timestamp: 1783616286291,
        type: 'review',
        childId: 'child_1',
        character: '途',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-09',
      },
      {
        timestamp: 1785205079007,
        type: 'review',
        childId: 'child_1',
        character: '途',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-27',
      },
    ]

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    // 旧版快照（无 appliedThrough）→ 逐字校验修复：07-09 的复习未到期
    // （07-08 评 a 后 07-11 才到期），按防护语义不计入 → reps 2 / interval 8
    const state = mockSaveCurrentSnapshot.mock.calls.at(-1)[0].state
    expect(state.children[0].progress['途']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
    })
    // nextCharIndex 不被重复推进
    expect(state.children[0].nextCharIndex).toBe(2)
    // 日志仍全部追加到 DB（用于同步/审计），且未去重丢失
    const appended = mockAppendLogs.mock.calls[0][0]
    expect(appended.length).toBe(3)
  })

  it('快照时间戳之后的日志仍会重放（快照较旧时补全新进度）', async () => {
    const result = await renderWithBulkImport()

    const snapshot = {
      timestamp: 1000,
      state: {
        children: [
          {
            id: 'child_1',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 0,
            progress: {
              一: {
                ease: 2.8,
                interval: 22,
                repetitions: 3,
                nextReview: '2026-08-18',
                lastGrade: 'a',
                firstReviewDay: '2026-07-01',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    // 快照时间戳之后的 review：但 07-27 < nextReview 08-18，未到期防护
    // 不允许重复计入（快照状态已包含该复习的效果）
    const logs = [
      {
        timestamp: 2000,
        type: 'review',
        childId: 'child_1',
        character: '一',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-27',
      },
    ]

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    const state = mockSaveCurrentSnapshot.mock.calls.at(-1)[0].state
    expect(state.children[0].progress['一']).toMatchObject({
      ease: 2.8,
      interval: 22,
      repetitions: 3,
    })
  })

  it('早期快照 + 后期日志：基座只含 07-09 前的 2 次学习，重放 07-27 日志后正确得到 3 次', async () => {
    const result = await renderWithBulkImport()

    // 用户场景：导入 20260731 目录时以早期快照（snapshot_2026-07-01.json，
    // 实际时间戳 07-09 23:03，含'途' 2 次学习）为基座，后期日志（07-11/07-21）
    // 在其上重放。'途' 的三条 review 中只有 07-27 在基座之后，应恰好补成 3 次。
    const snapshot = {
      timestamp: 1783663380979,
      state: {
        children: [
          {
            id: 'child_1',
            name: '陈尚恩',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              途: {
                ease: 2.7,
                interval: 8,
                repetitions: 2,
                nextReview: '2026-07-17',
                lastGrade: 'a',
                firstReviewDay: '2026-07-08',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '途'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    const logs = [
      {
        timestamp: 1783566656274,
        type: 'review',
        childId: 'child_1',
        character: '途',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-08',
      },
      {
        timestamp: 1783616286291,
        type: 'review',
        childId: 'child_1',
        character: '途',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-09',
      },
      {
        timestamp: 1785205079007,
        type: 'review',
        childId: 'child_1',
        character: '途',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-27',
      },
    ]

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    // 旧版快照（无 appliedThrough）→ 逐字校验修复后按防护语义：
    // 07-09 未到期不计入 → 只有 07-08 与 07-27 两次；interval 8（非 595）
    const state = mockSaveCurrentSnapshot.mock.calls.at(-1)[0].state
    expect(state.children[0].progress['途']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
    })
  })

  it('导入含重复条目的日志时先去重（DB 无重复、interval 不爆炸）', async () => {
    const result = await renderWithBulkImport()

    const snapshot = {
      timestamp: 1000,
      state: {
        children: [
          { id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    // 导出数据可能携带历史同步 bug 的重复条目（同一条 review ×14）
    const review = {
      timestamp: 2000,
      type: 'review',
      childId: 'child_1',
      character: '一',
      grade: 'a',
      round: 1,
      dayKey: '2026-07-01',
    }
    const logs = Array(14).fill(review)

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    // 去重后只应用一次：interval 3（而非爆炸值）
    const state = mockSaveCurrentSnapshot.mock.calls.at(-1)[0].state
    expect(state.children[0].progress['一']).toMatchObject({
      ease: 2.6,
      interval: 3,
      repetitions: 1,
    })
    // 写入 DB 的日志已去重：只追加 1 条
    const appended = mockAppendLogs.mock.calls.at(-1)[0]
    expect(appended.length).toBe(1)
  })

  it('快照带 appliedThrough 水位时按水位过滤重放，且保存时保留水位', async () => {
    const result = await renderWithBulkImport()

    // 时钟回拨场景：快照 timestamp（墙钟）=1000，但水位=5000——
    // ts 1500 的条目已被快照物化，按墙钟过滤会重复应用，按水位不会
    const snapshot = {
      timestamp: 1000,
      appliedThrough: 5000,
      state: {
        children: [
          {
            id: 'child_1',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 0,
            progress: {
              一: {
                ease: 2.6,
                interval: 3,
                repetitions: 1,
                nextReview: '2026-07-04',
                lastGrade: 'a',
                firstReviewDay: '2026-07-01',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['一', '二'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    const logs = [
      {
        timestamp: 1500, // 墙钟过滤会重放它，水位过滤不会
        type: 'review',
        childId: 'child_1',
        character: '一',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-02',
      },
      {
        timestamp: 6000, // 水位之后 → 必须重放（新字）
        type: 'review',
        childId: 'child_1',
        character: '二',
        grade: 'a',
        round: 1,
        dayKey: '2026-07-06',
      },
    ]

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    const saved = mockSaveCurrentSnapshot.mock.calls.at(-1)[0]
    // 水位之前的条目不重放（一保持 reps 1，而不是 2）
    expect(saved.state.children[0].progress['一'].repetitions).toBe(1)
    // 水位之后的条目重放（新字「二」被物化）
    expect(saved.state.children[0].progress['二']).toBeDefined()
    // 保存的水位推进到重放条目的最大 timestamp
    expect(saved.appliedThrough).toBe(6000)
  })

  it('导入旧版污染快照（无 appliedThrough）时逐字校验修复', async () => {
    const result = await renderWithBulkImport()

    // 真实事故模式：今 3 条日志被应用 3 次 → reps 9 / interval 21362
    const snapshot = {
      timestamp: 1000,
      state: {
        children: [
          {
            id: 'child_1',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              今: {
                ease: 3.4,
                interval: 21362,
                repetitions: 9,
                nextReview: '2085-01-28',
                lastGrade: 'a',
                firstReviewDay: '2026-05-18',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['今', '二'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    const logs = [
      { timestamp: 100, type: 'review', childId: 'child_1', character: '今', grade: 'a', round: 1, dayKey: '2026-05-18' },
      { timestamp: 200, type: 'review', childId: 'child_1', character: '今', grade: 'a', round: 1, dayKey: '2026-05-19' },
      { timestamp: 300, type: 'review', childId: 'child_1', character: '今', grade: 'a', round: 1, dayKey: '2026-08-04' },
    ]

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    const saved = mockSaveCurrentSnapshot.mock.calls.at(-1)[0]
    expect(saved.state.children[0].progress['今']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
    })
    // 修复后写入水位标记（P3 产物）：max(快照墙钟 1000, 日志最大 ts 300)
    expect(saved.appliedThrough).toBe(1000)
  })

  it('导入旧版快照时不可验证的重污染字被 8a 兑底（NaN 日期 → interval 1）', async () => {
    const result = await renderWithBulkImport()

    const snapshot = {
      timestamp: 1000,
      state: {
        children: [
          {
            id: 'child_1',
            name: '小明',
            wordBookId: 'wb_1',
            nextCharIndex: 1,
            progress: {
              花: {
                ease: 6.8,
                interval: 1.79e28,
                repetitions: 43,
                nextReview: 'NaN-NaN-NaN',
                lastGrade: 'a',
                firstReviewDay: '2026-05-30',
              },
            },
          },
        ],
        wordBooks: [{ id: 'wb_1', name: '生字本', characters: ['花'] }],
        settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
      },
    }
    // 日志缺早期复习：firstReviewDay 不一致 → 不可验证 → 只能兑底
    const logs = [
      { timestamp: 100, type: 'review', childId: 'child_1', character: '花', grade: 'a', round: 1, dayKey: '2026-07-01' },
    ]

    await act(async () => {
      await result.current.bulkImport(snapshot, logs)
    })

    const saved = mockSaveCurrentSnapshot.mock.calls.at(-1)[0]
    expect(saved.state.children[0].progress['花']).toMatchObject({ ease: 2.5, interval: 1 })
    expect(saved.state.children[0].progress['花'].nextReview).not.toBe('NaN-NaN-NaN')
  })
})
