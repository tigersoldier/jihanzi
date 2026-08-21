/**
 * @vitest-environment jsdom
 *
 * Tests for SyncContext — verifies the initialSyncPending lifecycle:
 * 登录后首次拉取挂起标记从 effect 同步置位，到拉取 settle（无论成败）解除。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import { SyncProvider, useSync } from './SyncContext'

const {
  mockIsLoggedIn,
  mockReloadState,
  mockInitialPull,
  mockGetLastKnownRemoteTime,
  mockOnSyncStatusChange,
} = vi.hoisted(() => ({
  mockIsLoggedIn: vi.fn(() => false),
  mockReloadState: vi.fn(),
  mockInitialPull: vi.fn(() => Promise.resolve({ didMerge: false })),
  mockGetLastKnownRemoteTime: vi.fn(() => Promise.resolve(0)),
  mockOnSyncStatusChange: vi.fn(() => () => {}),
}))

vi.mock('./AuthContext', () => ({
  useAuth: () => ({ isLoggedIn: mockIsLoggedIn() }),
}))

vi.mock('./AppContext', () => ({
  useApp: () => ({ reloadState: mockReloadState }),
}))

vi.mock('../data/sync', () => ({
  onSyncStatusChange: mockOnSyncStatusChange,
  startBackgroundSync: vi.fn(),
  stopBackgroundSync: vi.fn(),
  checkOnlineStatus: vi.fn(),
  syncOnce: vi.fn(() => Promise.resolve(false)),
  initialPull: (...args: unknown[]) => mockInitialPull(...args),
  ensureIntervalFilesOnDrive: vi.fn(() => Promise.resolve()),
  repairPollutedData: vi.fn(() =>
    Promise.resolve({ snapshotRepaired: false, filesRepaired: 0, salvaged: 0 }),
  ),
}))

vi.mock('../data/db', () => ({
  getLastKnownRemoteTime: () => mockGetLastKnownRemoteTime(),
}))

function Wrapper({ children }: { children: ReactNode }) {
  return React.createElement(SyncProvider, null, children)
}

describe('SyncContext initialSyncPending', () => {
  beforeEach(() => {
    mockIsLoggedIn.mockReturnValue(false)
    mockInitialPull.mockImplementation(() => Promise.resolve({ didMerge: false }))
    mockGetLastKnownRemoteTime.mockResolvedValue(0)
    mockReloadState.mockClear()
  })

  it('未登录时 initialSyncPending 为 false', () => {
    const { result } = renderHook(() => useSync(), { wrapper: Wrapper })
    expect(result.current.initialSyncPending).toBe(false)
  })

  it('登录后首次拉取挂起期间为 true，拉取完成后解除', async () => {
    // 可控的拉取 promise：手动 resolve 以观察挂起中间态
    let resolvePull!: (value: unknown) => void
    mockInitialPull.mockImplementation(
      () => new Promise(resolve => void (resolvePull = resolve)),
    )

    const { result, rerender } = renderHook(() => useSync(), { wrapper: Wrapper })

    mockIsLoggedIn.mockReturnValue(true)
    await act(async () => {
      rerender()
    })

    // effect 同步置位，拉取尚未完成 → 挂起中
    expect(result.current.initialSyncPending).toBe(true)
    expect(mockInitialPull).toHaveBeenCalled()

    // 拉取完成 → 解除挂起
    await act(async () => {
      resolvePull({ didMerge: false })
    })
    expect(result.current.initialSyncPending).toBe(false)
  })

  it('拉取失败（reject）时同样解除挂起——离线/失败允许开始学习', async () => {
    let rejectPull!: (err: unknown) => void
    mockInitialPull.mockImplementation(
      () => new Promise((_, reject) => void (rejectPull = reject)),
    )

    const { result, rerender } = renderHook(() => useSync(), { wrapper: Wrapper })

    mockIsLoggedIn.mockReturnValue(true)
    await act(async () => {
      rerender()
    })
    expect(result.current.initialSyncPending).toBe(true)

    await act(async () => {
      rejectPull(new Error('network down'))
    })
    expect(result.current.initialSyncPending).toBe(false)
  })

  it('拉取合并远程数据（didMerge）→ 触发 reloadState', async () => {
    mockInitialPull.mockResolvedValue({ didMerge: true })

    const { result, rerender } = renderHook(() => useSync(), { wrapper: Wrapper })

    mockIsLoggedIn.mockReturnValue(true)
    await act(async () => {
      rerender()
    })

    expect(mockReloadState).toHaveBeenCalledTimes(1)
    expect(result.current.initialSyncPending).toBe(false)
  })
})
