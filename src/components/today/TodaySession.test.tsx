/**
 * @vitest-environment jsdom
 *
 * Tests for TodaySession — the learning session UI extracted from ProgressPage.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import React, { useState, type ReactNode } from 'react'
import type { AppState } from '../../core/types'
import { AppContext, type AppContextState } from '../../state/AppContext'

// Mock localStorage
const localStorageStore = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => localStorageStore.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { localStorageStore.set(key, value) }),
  removeItem: vi.fn((key: string) => { localStorageStore.delete(key) }),
})

// Mock date to a known learn-day
vi.mock('../../utils/date', async () => {
  const actual = await vi.importActual<typeof import('../../utils/date')>('../../utils/date')
  return { ...actual, todayKey: () => '2026-01-01' }
})

import { TodaySession } from './ProgressPage'

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
  })

  it('renders idle state with task count and character preview for the selected child', async () => {
    const state = makeState({
      children: [{
        id: 'child_1', name: '小明', wordBookId: 'wb_1',
        nextCharIndex: 0, progress: {},
      }],
      wordBooks: [{
        id: 'wb_1', name: '测试', characters: ['一', '二', '三'],
      }],
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
      children: [{
        id: 'child_1', name: '小明', wordBookId: 'wb_1',
        nextCharIndex: 0, progress: {},
      }],
      wordBooks: [{
        id: 'wb_1', name: '测试', characters: ['一', '二', '三'],
      }],
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
})
