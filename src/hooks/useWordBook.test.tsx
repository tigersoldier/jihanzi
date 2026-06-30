/**
 * @vitest-environment jsdom
 *
 * Tests for useWordBook hook — verifies word book management behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { useState, useRef, useCallback, type ReactNode } from 'react'
import type { AppState } from '../core/types'
import { AppContext, type AppContextState } from '../state/AppContext'
import { validateAddChar, ValidationError } from '../utils/chars'

import { useWordBook } from './useWordBook'

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

function stateWithWordBook(characters: string[] = []): AppState {
  return makeState({
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
// Stateful wrapper that tracks character additions
// ---------------------------------------------------------------

function createStatefulWrapper(initialState: AppState) {
  // Track which characters addCharacter was called with (arguments
  // passed to the AppContext addCharacter function).
  const addedChars: string[] = []

  function StatefulWrapper({ children }: { children: ReactNode }) {
    const [state, setState] = useState<AppState>(initialState)

    // Mirror word books in a ref so addCharacter can validate without
    // depending on state (keeps callback stable and avoids stale-closure
    // issues during batch adds).
    const wordBooksRef = useRef(state.wordBooks)
    wordBooksRef.current = state.wordBooks

    const addCharacter = useCallback(
      async (wordBookId: string, character: string) => {
        const wb = wordBooksRef.current.find(w => w.id === wordBookId)
        if (!wb) return
        validateAddChar(character, wb)
        addedChars.push(character)

        // Eagerly update ref so sequential calls in the same microtask
        // see each other's additions (mirrors AppContext behaviour).
        wordBooksRef.current = wordBooksRef.current.map(w =>
          w.id === wordBookId
            ? { ...w, characters: [...w.characters, character] }
            : w
        )

        setState(prev => ({
          ...prev,
          wordBooks: prev.wordBooks.map(w =>
            w.id === wordBookId
              ? { ...w, characters: [...w.characters, character] }
              : w
          ),
        }))
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
      addCharacter,
      removeCharacter: vi.fn() as any,
      reorderCharacters: vi.fn() as any,
      submitReview: vi.fn() as any,
      updateSettings: vi.fn() as any,
      getLogEntries: vi.fn() as any,
    }

    return React.createElement(AppContext.Provider, { value: contextValue }, children)
  }
  StatefulWrapper.displayName = 'StatefulWrapper'
  return { wrapper: StatefulWrapper, addedChars }
}

// ---------------------------------------------------------------
// Tests
// ---------------------------------------------------------------

describe('useWordBook', () => {
  describe('addCharacter', () => {
    it('空生字本中添加逗号分隔的汉字 → 所有汉字都添加，逗号被跳过', async () => {
      // Given: 空生字本
      const initialState = stateWithWordBook([])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      // When: 输入 "你好，世界"（包含中文逗号）
      await act(async () => {
        await result.current.addCharacter('你好，世界')
      })

      // Then: 4 个汉字全部添加，逗号被跳过
      expect(addedChars).toEqual(['你', '好', '世', '界'])
      expect(result.current.currentWB?.characters).toEqual(['你', '好', '世', '界'])
    })

    it('输入中包含英文逗号 → 逗号被跳过，汉字全部添加', async () => {
      const initialState = stateWithWordBook([])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      await act(async () => {
        await result.current.addCharacter('花,鸟,虫')
      })

      expect(addedChars).toEqual(['花', '鸟', '虫'])
    })

    it('输入中包含空格 → 空格被跳过', async () => {
      const initialState = stateWithWordBook([])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      await act(async () => {
        await result.current.addCharacter('山 水 火')
      })

      // Spaces are stripped by trim(), but characters are extracted
      expect(addedChars).toEqual(['山', '水', '火'])
    })

    it('输入中包含句号和其他标点 → 标点被跳过', async () => {
      const initialState = stateWithWordBook([])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      await act(async () => {
        await result.current.addCharacter('大。小？上、')
      })

      expect(addedChars).toEqual(['大', '小', '上'])
    })

    it('已存在的汉字 → 抛错但不影响后续汉字的添加', async () => {
      // Given: 生字本已有 "花"
      const initialState = stateWithWordBook(['花'])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      // When: 输入 "花鸟虫"（花已存在）
      // Note: the real AppContext validates each character, so duplicates throw.
      // We test that the hook continues processing after a duplicate error.
      await act(async () => {
        await result.current.addCharacter('花鸟虫')
      })

      // Then: "花" 报错被跳过，"鸟" 和 "虫" 正常添加
      expect(addedChars).toEqual(['鸟', '虫'])
    })

    it('全是非汉字 → 什么都不添加', async () => {
      const initialState = stateWithWordBook([])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      await act(async () => {
        await result.current.addCharacter('123, @#$')
      })

      // Nothing added — all chars are non-Chinese
      expect(addedChars).toEqual([])
    })

    it('系统错误（非 ValidationError）→ 传播给调用方，不静默吞掉', async () => {
      // Given: 模拟的 addCharacter 抛出一个普通 Error（模拟 IndexedDB 失败）
      const systemError = new Error('IndexedDB write failed')

      function SystemErrorWrapper({ children }: { children: ReactNode }) {
        const [state] = useState<AppState>(stateWithWordBook([]))

        const addCharacter = useCallback(
          async (_wordBookId: string, _character: string) => {
            throw systemError
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
          addCharacter,
          removeCharacter: vi.fn() as any,
          reorderCharacters: vi.fn() as any,
          submitReview: vi.fn() as any,
          updateSettings: vi.fn() as any,
          getLogEntries: vi.fn() as any,
        }

        return React.createElement(AppContext.Provider, { value: contextValue }, children)
      }
      SystemErrorWrapper.displayName = 'SystemErrorWrapper'

      const { result } = renderHook(() => useWordBook(), { wrapper: SystemErrorWrapper })

      // When/Then: addCharacter 应该 reject 而不是静默吞掉错误
      await act(async () => {
        await expect(result.current.addCharacter('你好')).rejects.toThrow('IndexedDB write failed')
      })
    })

    it('同一批次中重复的字 → 第二个被拒绝不添加', async () => {
      // Given: 空生字本
      const initialState = stateWithWordBook([])
      const { wrapper, addedChars } = createStatefulWrapper(initialState)

      const { result } = renderHook(() => useWordBook(), { wrapper })

      // When: 输入 "一一"（同一批次两个相同字）
      await act(async () => {
        await result.current.addCharacter('一一')
      })

      // Then: 只添加一次（第二个被 validateAddChar 拒绝）
      expect(addedChars).toEqual(['一'])
    })
  })
})
