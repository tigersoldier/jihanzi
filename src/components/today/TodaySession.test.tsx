/**
 * @vitest-environment jsdom
 *
 * Tests for TodaySession — the learning session UI extracted from ProgressPage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import type { AppState } from '../../core/types'
import { AppContext, type AppContextState } from '../../state/AppContext'

// Mock localStorage
const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => {
    localStorageStore.set(key, value)
  }),
  removeItem: vi.fn((key: string) => {
    localStorageStore.delete(key)
  }),
})

// Mock date to a known learn-day
vi.mock('../../utils/date', async () => {
  const actual = await vi.importActual<typeof import('../../utils/date')>('../../utils/date')
  return { ...actual, todayKey: () => '2026-01-01' }
})

import { TodaySession } from './ProgressPage'

// Mock SyncContext — 默认已同步完成，现有测试不受影响。
const { mockSyncStatus, mockInitialSyncPending } = vi.hoisted(() => ({
  mockSyncStatus: vi.fn(() => 'online' as const),
  mockInitialSyncPending: vi.fn(() => false),
}))

vi.mock('../../state/SyncContext', () => ({
  useSync: () => ({
    status: mockSyncStatus(),
    initialSyncPending: mockInitialSyncPending(),
    lastSyncTime: null,
    syncNow: vi.fn(),
  }),
}))

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [],
    wordBooks: [],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    ...overrides,
  }
}

function wrapperWith(state: AppState, childId = '') {
  const selectedChildId = childId || state.children[0]?.id || ''
  function Wrapper({ children }: { children: ReactNode }) {
    const contextValue: AppContextState = {
      state,
      loading: false,
      dataVersion: 0,
      selectedChildId,
      setSelectedChildId: vi.fn(),
      reloadState: vi.fn(),
      createChild: vi.fn() as any,
      updateChild: vi.fn() as any,
      deleteChild: vi.fn() as any,
      createWordBook: vi.fn() as any,
      updateWordBook: vi.fn() as any,
      deleteWordBook: vi.fn() as any,
      addCharacter: vi.fn() as any,
      removeCharacter: vi.fn() as any,
      reorderCharacters: vi.fn() as any,
      submitReview: vi.fn() as any,
      submitPresentChars: vi.fn() as any,
      updateSettings: vi.fn() as any,
      getLogEntries: vi.fn() as any,
      bulkImport: vi.fn() as any,
    }
    return React.createElement(AppContext.Provider, { value: contextValue }, children)
  }
  Wrapper.displayName = 'Wrapper'
  return Wrapper
}

describe('TodaySession', () => {
  beforeEach(() => {
    localStorageStore.clear()
    mockSyncStatus.mockReturnValue('online')
    mockInitialSyncPending.mockReturnValue(false)
  })

  afterEach(() => {
    // 项目未开 vitest globals，RTL 不会自动清理 DOM——不清理会残留上一测试的渲染
    cleanup()
  })

  it('renders idle state with task count and character preview for the selected child', async () => {
    const state = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '测试',
          characters: ['一', '二', '三'],
        },
      ],
    })

    render(<TodaySession />, { wrapper: wrapperWith(state, 'child_1') })

    // 等待 useDayType 的 IndexedDB 查询完成（jsdom 中会 reject → loading=false）
    await waitFor(() => {
      expect(screen.getByText(/准备复习 3 个字/)).toBeDefined()
    })
    expect(screen.getByText('开始学习')).toBeDefined()
    // 预览列表：应显示新学组，不显示复习组（文本跨 span 拆分用 getByText 查子元素）
    expect(screen.getByText('新学：')).toBeDefined()
    expect(screen.getByText('一、二、三')).toBeDefined()
  })

  it('shows after-session preview with tomorrow tasks when day is done', async () => {
    const state = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '测试',
          characters: ['一', '二', '三'],
        },
      ],
    })

    // 预设 doneToday 标记
    localStorageStore.set('jihanzi_done_child_1_2026-01-01', '1')

    render(<TodaySession />, { wrapper: wrapperWith(state, 'child_1') })

    // 等待 useDayType 查询完成
    await waitFor(() => {
      expect(screen.getByText('今日已完成')).toBeDefined()
    })
    // 明天是纯复习日且无到期任务 → 显示空状态提示（不显示日类型标签）
    expect(screen.getByText('明天没有需要复习或学习的字')).toBeDefined()
  })

  it('同步拉取期间隐藏任务预览与开始按钮，显示同步占位', async () => {
    mockSyncStatus.mockReturnValue('syncing')
    const state = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '测试',
          characters: ['一', '二', '三'],
        },
      ],
    })

    render(<TodaySession />, { wrapper: wrapperWith(state, 'child_1') })

    await waitFor(() => {
      expect(screen.getByText(/正在同步数据/)).toBeDefined()
    })
    // 预览与按钮均不显示（不显示过期任务列表）
    expect(screen.queryByText('开始学习')).toBeNull()
    expect(screen.queryByText(/准备复习/)).toBeNull()
    expect(screen.queryByText('新学：')).toBeNull()
  })

  it('首次拉取挂起时同样显示同步占位；同步完成后恢复正常', async () => {
    mockInitialSyncPending.mockReturnValue(true)
    const state = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '测试',
          characters: ['一', '二', '三'],
        },
      ],
    })

    const { rerender } = render(<TodaySession />, { wrapper: wrapperWith(state, 'child_1') })

    await waitFor(() => {
      expect(screen.getByText(/正在同步数据/)).toBeDefined()
    })

    // 拉取完成 → 占位消失，恢复任务预览与按钮
    mockInitialSyncPending.mockReturnValue(false)
    rerender(<TodaySession />)
    await waitFor(() => {
      expect(screen.getByText('开始学习')).toBeDefined()
    })
    expect(screen.queryByText(/正在同步数据/)).toBeNull()
  })
})
