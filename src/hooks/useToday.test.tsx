/**
 * @vitest-environment jsdom
 *
 * Tests for useToday hook — verifies the learning session behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { useState, useCallback, type ReactNode } from 'react'
import type { AppState } from '../core/types'
import { AppContext, type AppContextState } from '../state/AppContext'

// Mock localStorage (Node 22+ has a built-in stub that overrides jsdom's)
let localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { localStorageStore.set(key, value) }),
  removeItem: vi.fn((key: string) => { localStorageStore.delete(key) }),
})

// Mock the date module to use a known "learn" day
vi.mock('../utils/date', async () => {
  const actual = await vi.importActual<typeof import('../utils/date')>('../utils/date')
  const LEARN_DAY = '2026-01-01'
  return {
    ...actual,
    todayKey: () => LEARN_DAY,
  }
})

import { useToday } from './useToday'

// ---------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [],
    wordBooks: [],
    settings: {
      dailyReviewLimit: 30,
      dailyNewChars: 5,
      maxRounds: 3,
    },
    ...overrides,
  }
}

function freshStateWithChars(characters: string[]): AppState {
  return makeState({
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
        name: '测试生字本',
        characters,
      },
    ],
  })
}

// ---------------------------------------------------------------
// Stateful test wrapper that simulates real AppContext behavior
// ---------------------------------------------------------------

function createStatefulWrapper(initialState: AppState) {
  function StatefulWrapper({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AppState>(initialState)
    const [selectedChildId, setSelectedChildId] = useState<string>(
      () => state.children[0]?.id || ''
    )

    const submitReview = useCallback(
      async (
        childId: string,
        character: string,
        _grade: 'a' | 'b' | 'c' | 'd',
        round: number,
        _dayKey: string,
      ) => {
        if (round !== 1) return

        setState(prev => {
          const newState = JSON.parse(JSON.stringify(prev)) as AppState
          const child = newState.children.find(c => c.id === childId)
          if (!child) return prev

          // Advance nextCharIndex for new characters
          if (!child.progress[character]) {
            const wb = newState.wordBooks.find(w => w.id === child.wordBookId)
            if (wb) {
              const charIndex = wb.characters.indexOf(character)
              if (charIndex >= child.nextCharIndex) {
                child.nextCharIndex = charIndex + 1
              }
            }
          }

          // Add SM-2 state entry
          child.progress[character] = {
            ease: 2.6,
            interval: 1,
            repetitions: 1,
            nextReview: '2026-01-02',
            lastGrade: 'a',
          }

          return newState
        })
      },
      [],
    )

    const contextValue: AppContextState = {
      state,
      loading: false,
      dataVersion: 0,
      selectedChildId,
      setSelectedChildId,
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
      submitReview,
      updateSettings: vi.fn() as any,
      getLogEntries: vi.fn() as any,
      bulkImport: vi.fn() as any,
    }

    return React.createElement(AppContext.Provider, { value: contextValue }, children)
  }
  StatefulWrapper.displayName = 'StatefulWrapper'
  return StatefulWrapper
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('useToday', () => {
  beforeEach(() => {
    localStorageStore = new Map()
  })

  it('刷新页面后恢复复习进度', async () => {
    // Given: 一个孩子有一个包含五个生字的生字本
    const initialState = freshStateWithChars(['一', '二', '三', '四', '五'])
    const wrapper = createStatefulWrapper(initialState)

    const { result, unmount } = renderHook(() => useToday(), { wrapper })

    // 开始学习
    act(() => {
      result.current.startSession()
    })
    expect(result.current.phase).toBe('reviewing')
    expect(result.current.taskIndex).toBe(0)
    expect(result.current.currentTask?.character).toBe('一')

    // 评分「一」为 a
    await act(async () => {
      result.current.handleRate('a')
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    expect(result.current.taskIndex).toBe(1)
    expect(result.current.currentTask?.character).toBe('二')

    // 模拟刷新：卸载
    unmount()

    // 构造刷新后的 state（模拟 IndexedDB 恢复后的状态）
    // 「一」已被复习，nextCharIndex 推进到 1
    const afterRefreshState = freshStateWithChars(['一', '二', '三', '四', '五'])
    afterRefreshState.children[0].nextCharIndex = 1
    afterRefreshState.children[0].progress = {
      '一': {
        ease: 2.6,
        interval: 1,
        repetitions: 1,
        nextReview: '2026-01-02',
        lastGrade: 'a',
      },
    }

    const newWrapper = createStatefulWrapper(afterRefreshState)

    // 重新挂载（模拟刷新后重新进入页面）
    const { result: result2 } = renderHook(() => useToday(), { wrapper: newWrapper })

    // Then: 应该恢复到之前的进度 — 在「二」而不是回到「一」
    // 注意：totalTasks 不变（sessionTasks 快照被恢复），但实际剩余任务数会变
    expect(result2.current.phase).toBe('reviewing')
    expect(result2.current.taskIndex).toBe(1)
    expect(result2.current.currentTask?.character).toBe('二')
  })

  it('正常完成会话后清除持久化的会话', async () => {
    // Given: 一个孩子有一个生字
    const initialState = freshStateWithChars(['一'])
    const wrapper = createStatefulWrapper(initialState)

    const { result, unmount } = renderHook(() => useToday(), { wrapper })

    // 开始学习
    act(() => {
      result.current.startSession()
    })
    expect(result.current.phase).toBe('reviewing')

    // 评完所有字（只有「一」）
    await act(async () => {
      result.current.handleRate('a')
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    // 应该进入 roundComplete
    expect(result.current.phase).toBe('roundComplete')

    // 完成会话
    act(() => {
      result.current.handleDone()
    })
    expect(result.current.phase).toBe('idle')

    unmount()

    // 重新挂载 — 已完成会话，不应恢复
    const newWrapper = createStatefulWrapper(initialState)
    const { result: result2 } = renderHook(() => useToday(), { wrapper: newWrapper })

    expect(result2.current.phase).toBe('idle')
    expect(result2.current.taskIndex).toBe(0)
  })

  it('学习新字时按顺序逐字推进，不跳字', async () => {
    // Given: 一个孩子有一个包含五个生字的生字本（一、二、三、四、五）
    const initialState = freshStateWithChars(['一', '二', '三', '四', '五'])
    const wrapper = createStatefulWrapper(initialState)

    const { result } = renderHook(() => useToday(), { wrapper })

    // 确认 session 开始前有 5 个任务
    expect(result.current.totalTasks).toBe(5)

    // 开始学习
    act(() => {
      result.current.startSession()
    })

    expect(result.current.phase).toBe('reviewing')
    expect(result.current.taskIndex).toBe(0)
    expect(result.current.currentTask?.character).toBe('一')

    // When: 评分「一」为 a
    // submitReview 触发 state 更新（nextCharIndex 0→1），
    // 但 sessionTasks 快照保持不变，不应跳字
    await act(async () => {
      result.current.handleRate('a')
      // 等待 setTimeout 推进 taskIndex（350ms + 余量）
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    // Then: 应该在「二」而不是「三」
    expect(result.current.taskIndex).toBe(1)
    expect(result.current.currentTask?.character).toBe('二')
  })

  it('快速双击评分按钮时只提交一次 review', async () => {
    // Given: 一个孩子有一个生字
    const initialState = freshStateWithChars(['一'])
    const wrapper = createStatefulWrapper(initialState)

    const { result } = renderHook(() => useToday(), { wrapper })

    act(() => {
      result.current.startSession()
    })

    // When: 在 350ms 内快速双击「a」按钮
    await act(async () => {
      result.current.handleRate('a')  // 第一次点击
      result.current.handleRate('a')  // 第二次点击（双击）
      // 等待 setTimeout 推进 taskIndex
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    // Then: sessionStats 应该只计一次（验证双击被拦截）
    expect(result.current.sessionStats.a).toBe(1)
  })

  it('首次加载 state.children 异步到达后自动选中第一个孩子', async () => {
    // 模拟真实的 AppContext 行为：初始化时 state.children 为空（IndexedDB
    // 尚未加载），之后 async loadState 完成才 setState 填入 children。
    // useToday 在首次渲染时 selectedChildId = ''，等 children 到达后应
    // 自动设置为第一个孩子的 ID 并生成任务队列。
    function AsyncLoadingWrapper({ children: inner }: { children: ReactNode }) {
      const [state, setState] = useState<AppState>(
        makeState({
          children: [],
          wordBooks: [
            { id: 'wb_1', name: '测试生字本', characters: ['一', '二', '三'] },
          ],
        })
      )
      const [selectedChildId, setSelectedChildId] = useState('')

      // 模拟 IndexedDB 异步加载 — 在 useEffect 中延迟填入 children
      React.useEffect(() => {
        // 使用 queueMicrotask 确保在本次渲染提交之后执行
        queueMicrotask(() => {
          setState(makeState({
            children: [
              { id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} },
            ],
            wordBooks: [
              { id: 'wb_1', name: '测试生字本', characters: ['一', '二', '三'] },
            ],
          }))
        })
      }, [])

      // 模拟 AppContext 的 auto-select 逻辑
      React.useEffect(() => {
        if (state.children.length > 0 && !selectedChildId) {
          setSelectedChildId(state.children[0].id)
        }
      }, [state.children, selectedChildId])

      const contextValue: AppContextState = {
        state,
        loading: false,
        dataVersion: 0,
        selectedChildId,
        setSelectedChildId,
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
        updateSettings: vi.fn() as any,
        getLogEntries: vi.fn() as any,
        bulkImport: vi.fn() as any,
      }

      return React.createElement(AppContext.Provider, { value: contextValue }, inner)
    }
    AsyncLoadingWrapper.displayName = 'AsyncLoadingWrapper'

    const { result, rerender } = renderHook(() => useToday(), { wrapper: AsyncLoadingWrapper })

    // 首次渲染：还没有 children
    expect(result.current.selectedChildId).toBe('')
    expect(result.current.isReady).toBe(false)
    expect(result.current.totalTasks).toBe(0)

    // 等待异步状态更新（setState 在 microtask 中）
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })

    // 状态更新后：应自动选中第一个孩子并生成任务
    expect(result.current.selectedChildId).toBe('child_1')
    expect(result.current.isReady).toBe(true)
    expect(result.current.totalTasks).toBe(3) // 学新日，3 个新字
  })

  it('多孩子场景下刷新后恢复正确的孩子进度', async () => {
    // Given: 两个孩子各有生字本
    const initialState = makeState({
      children: [
        { id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} },
        { id: 'child_2', name: '小红', wordBookId: 'wb_2', nextCharIndex: 0, progress: {} },
      ],
      wordBooks: [
        { id: 'wb_1', name: '小明生字本', characters: ['一', '二'] },
        { id: 'wb_2', name: '小红生字本', characters: ['花', '草'] },
      ],
    })
    const wrapper = createStatefulWrapper(initialState)

    const { result, unmount } = renderHook(() => useToday(), { wrapper })

    // 切换到第二个孩子
    act(() => {
      result.current.setSelectedChildId('child_2')
    })

    // 开始学习
    act(() => {
      result.current.startSession()
    })
    expect(result.current.phase).toBe('reviewing')
    expect(result.current.currentTask?.character).toBe('花')

    // 评分「花」为 a
    await act(async () => {
      result.current.handleRate('a')
      await new Promise(resolve => setTimeout(resolve, 400))
    })

    expect(result.current.taskIndex).toBe(1)
    expect(result.current.currentTask?.character).toBe('草')

    // 模拟刷新：卸载
    unmount()

    // 构造刷新后的 state（第二个孩子的进度被保留）
    const afterRefreshState = makeState({
      children: [
        { id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} },
        {
          id: 'child_2',
          name: '小红',
          wordBookId: 'wb_2',
          nextCharIndex: 1,
          progress: {
            '花': { ease: 2.6, interval: 1, repetitions: 1, nextReview: '2026-01-02', lastGrade: 'a', firstReviewDay: '2026-01-01' },
          },
        },
      ],
      wordBooks: [
        { id: 'wb_1', name: '小明生字本', characters: ['一', '二'] },
        { id: 'wb_2', name: '小红生字本', characters: ['花', '草'] },
      ],
    })

    const newWrapper = createStatefulWrapper(afterRefreshState)

    // 重新挂载（模拟刷新后重新进入页面）
    // selectedChildId 会重置为第一个孩子（'child_1'），但应恢复到 'child_2'
    const { result: result2 } = renderHook(() => useToday(), { wrapper: newWrapper })

    // Then: 应该恢复到第二个孩子的进度
    expect(result2.current.selectedChildId).toBe('child_2')
    expect(result2.current.phase).toBe('reviewing')
    expect(result2.current.taskIndex).toBe(1)
    expect(result2.current.currentTask?.character).toBe('草')
  })

  it('完成当日全部复习后不应允许立即开始新一轮', async () => {
    // Bug: handleDone() resets to idle, but generateTodayTasks() still
    // returns the next batch of new characters from the wordbook (because
    // nextCharIndex only advanced by dailyNewChars, not to the end).
    // The user can immediately start a new session on the same day.
    //
    // Given: 一个孩子有一个包含 10 个生字的生字本（超过 dailyNewChars=5）
    const initialState = freshStateWithChars([
      '一', '二', '三', '四', '五', '六', '七', '八', '九', '十',
    ])
    const wrapper = createStatefulWrapper(initialState)

    const { result } = renderHook(() => useToday(), { wrapper })

    // 开始学习 — 应该只有 5 个新字任务（dailyNewChars=5）
    expect(result.current.totalTasks).toBe(5)

    act(() => {
      result.current.startSession()
    })
    expect(result.current.phase).toBe('reviewing')

    // 逐字评分 'a'，完成第一轮
    const chars = ['一', '二', '三', '四', '五']
    for (let i = 0; i < chars.length; i++) {
      expect(result.current.currentTask?.character).toBe(chars[i])
      await act(async () => {
        result.current.handleRate('a')
        await new Promise(resolve => setTimeout(resolve, 400))
      })
    }

    // 全部评完 → roundComplete（无 c/d，needReview=0）
    expect(result.current.phase).toBe('roundComplete')

    // 跳到 celebration
    act(() => {
      result.current.handleSkipRound()
    })
    expect(result.current.phase).toBe('celebration')

    // 用户点击"返回首页"
    act(() => {
      result.current.handleDone()
    })
    expect(result.current.phase).toBe('idle')

    // Then: 不应该允许开始新一轮 — isReady 应为 false
    // 即使生字本中还有更多字（六、七、八、九、十），今天的配额已用完
    expect(result.current.isReady).toBe(false)
  })
})
