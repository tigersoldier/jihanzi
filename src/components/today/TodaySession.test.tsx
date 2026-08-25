/**
 * @vitest-environment jsdom
 *
 * Tests for TodaySession — the learning session UI extracted from ProgressPage.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react'
import React, { type ReactNode } from 'react'
import type { AppState } from '../../core/types'
import { AppContext, type AppContextState } from '../../state/AppContext'
import RoundComplete from './RoundComplete'
import Celebration from './Celebration'

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
      submitReview: vi.fn().mockResolvedValue(undefined) as any,
      submitPresentChars: vi.fn().mockResolvedValue(undefined) as any,
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

// ============================================================
// 朗读提醒（ReadAloudReminder）—— 轮次完成 / 庆祝界面列出所写汉字
// ============================================================

describe('RoundComplete 朗读提醒', () => {
  afterEach(() => {
    cleanup()
  })

  it('第 1 轮完成后列出本轮写的字并提醒朗读', () => {
    render(
      <RoundComplete
        round={1}
        needReview={0}
        maxRounds={3}
        roundChars={['一', '二', '三']}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    )

    expect(screen.getByText('第 1 轮完成')).toBeDefined()
    expect(screen.getByText('请让孩子把这轮写的字读一遍')).toBeDefined()
    expect(screen.getByText('第 1 轮写的字')).toBeDefined()
    expect(screen.getByText('一')).toBeDefined()
    expect(screen.getByText('二')).toBeDefined()
    expect(screen.getByText('三')).toBeDefined()
  })

  it('巩固轮完成后列出该轮写的字（仅本轮，不含上一轮）', () => {
    render(
      <RoundComplete
        round={2}
        needReview={1}
        maxRounds={3}
        roundChars={['一', '三']}
        onContinue={vi.fn()}
        onSkip={vi.fn()}
      />,
    )

    expect(screen.getByText('第 2 轮完成')).toBeDefined()
    expect(screen.getByText('第 2 轮写的字')).toBeDefined()
    expect(screen.getByText('一')).toBeDefined()
    expect(screen.getByText('三')).toBeDefined()
    expect(screen.queryByText('二')).toBeNull()
  })
})

describe('Celebration 朗读提醒', () => {
  afterEach(() => {
    cleanup()
  })

  it('按轮列出本次会话各轮写的字（含巩固轮）并提醒朗读', () => {
    render(
      <Celebration
        total={5}
        stats={{ a: 2, b: 1, c: 1, d: 1 }}
        groups={[
          { round: 1, chars: ['一', '二', '三'] },
          { round: 2, chars: ['二', '三'] },
        ]}
        onDone={vi.fn()}
      />,
    )

    expect(screen.getByText('请让孩子把今天写的字都读一遍')).toBeDefined()
    expect(screen.getByText('第 1 轮写的字')).toBeDefined()
    expect(screen.getByText('第 2 轮写的字')).toBeDefined()
    // 遗忘字跨轮重复出现，应每轮都列出
    expect(screen.getAllByText('二')).toHaveLength(2)
    expect(screen.getAllByText('三')).toHaveLength(2)
    expect(screen.getByText('一')).toBeDefined()
  })
})

// ============================================================
// 完整会话流程：轮次完成与庆祝界面的朗读提醒联动
// ============================================================

describe('TodaySession 朗读提醒联动', () => {
  beforeEach(() => {
    localStorageStore.clear()
  })

  afterEach(() => {
    cleanup()
  })

  const learnState = () =>
    makeState({
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

  /** 走完展示阶段进入复习阶段 */
  async function presentAllAndStartReview() {
    fireEvent.click(screen.getByText('下一个')) // 一 → 二
    fireEvent.click(screen.getByText('下一个')) // 二 → 三
    fireEvent.click(screen.getByText('开始复习')) // 进入复习
  }

  it('全部掌握：轮次完成提醒读本轮 3 个字，庆祝提醒读全部字', async () => {
    render(<TodaySession />, { wrapper: wrapperWith(learnState(), 'child_1') })

    await waitFor(() => expect(screen.getByText('开始学习')).toBeDefined())
    fireEvent.click(screen.getByText('开始学习'))
    await presentAllAndStartReview()

    // 第 1 轮：三个字全部评 a
    await screen.findByText('一')
    fireEvent.click(screen.getByText('完全掌握'))
    await screen.findByText('二')
    fireEvent.click(screen.getByText('完全掌握'))
    await screen.findByText('三')
    fireEvent.click(screen.getByText('完全掌握'))

    // 轮次完成：列出本轮 3 个字，提醒朗读
    await waitFor(() => expect(screen.getByText('第 1 轮完成')).toBeDefined())
    expect(screen.getByText('请让孩子把这轮写的字读一遍')).toBeDefined()
    expect(screen.getByText('第 1 轮写的字')).toBeDefined()
    expect(screen.getByText('一')).toBeDefined()
    expect(screen.getByText('二')).toBeDefined()
    expect(screen.getByText('三')).toBeDefined()

    // 进入庆祝：列出全部 3 个字
    fireEvent.click(screen.getByText('太棒了，继续'))
    await waitFor(() => expect(screen.getByText('今天完成 3 个字')).toBeDefined())
    expect(screen.getByText('请让孩子把今天写的字都读一遍')).toBeDefined()
    expect(screen.getByText('第 1 轮写的字')).toBeDefined()
    expect(screen.getByText('一')).toBeDefined()
    expect(screen.getByText('二')).toBeDefined()
    expect(screen.getByText('三')).toBeDefined()
  })

  it('有遗忘字进入巩固轮：每轮完成都提醒读本轮的字，庆祝列出两轮的字', async () => {
    render(<TodaySession />, { wrapper: wrapperWith(learnState(), 'child_1') })

    await waitFor(() => expect(screen.getByText('开始学习')).toBeDefined())
    fireEvent.click(screen.getByText('开始学习'))
    await presentAllAndStartReview()

    // 第 1 轮：一遗忘(d)、二掌握(a)、三需提示(c)
    await screen.findByText('一')
    fireEvent.click(screen.getByText('遗忘'))
    await screen.findByText('二')
    fireEvent.click(screen.getByText('完全掌握'))
    await screen.findByText('三')
    fireEvent.click(screen.getByText('需提示'))

    // 第 1 轮完成：2 个字需巩固，提醒朗读本轮 3 个字
    await waitFor(() => expect(screen.getByText('第 1 轮完成')).toBeDefined())
    expect(screen.getByText('2 个字需要再巩固')).toBeDefined()
    expect(screen.getByText('请让孩子把这轮写的字读一遍')).toBeDefined()
    expect(screen.getByText('一')).toBeDefined()
    expect(screen.getByText('二')).toBeDefined()
    expect(screen.getByText('三')).toBeDefined()

    // 进入第 2 轮巩固：只剩一、三
    fireEvent.click(screen.getByText('开始第 2 轮巩固'))
    await screen.findByText('一')
    expect(screen.getByText('第 2 轮')).toBeDefined()
    fireEvent.click(screen.getByText('完全掌握'))
    await screen.findByText('三')
    fireEvent.click(screen.getByText('完全掌握'))

    // 第 2 轮完成：提醒朗读本轮 2 个字（不含二）
    await waitFor(() => expect(screen.getByText('第 2 轮完成')).toBeDefined())
    expect(screen.getByText('请让孩子把这轮写的字读一遍')).toBeDefined()
    expect(screen.getByText('第 2 轮写的字')).toBeDefined()
    expect(screen.getByText('一')).toBeDefined()
    expect(screen.getByText('三')).toBeDefined()
    expect(screen.queryByText('二')).toBeNull()

    // 庆祝：两轮的字都列出（一、三 跨轮重复）
    fireEvent.click(screen.getByText('太棒了，继续'))
    await waitFor(() => expect(screen.getByText('今天完成 5 个字')).toBeDefined())
    expect(screen.getByText('请让孩子把今天写的字都读一遍')).toBeDefined()
    expect(screen.getByText('第 1 轮写的字')).toBeDefined()
    expect(screen.getByText('第 2 轮写的字')).toBeDefined()
    expect(screen.getAllByText('一')).toHaveLength(2)
    expect(screen.getAllByText('三')).toHaveLength(2)
    expect(screen.getByText('二')).toBeDefined()
  })
})
