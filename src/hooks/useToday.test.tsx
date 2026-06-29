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
          }

          return newState
        })
      },
      [],
    )

    const contextValue: AppContextState = {
      state,
      loading: false,
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
})
