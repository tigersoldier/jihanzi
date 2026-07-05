/**
 * @vitest-environment jsdom
 *
 * Tests for useHistory and useCharacterStats — verify that
 * queries skip when the viewed data hasn't actually changed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { useState, type ReactNode } from 'react'
import type { AppState, SM2State } from '../core/types'
import { AppContext, type AppContextState } from '../state/AppContext'
import * as db from '../data/db'

vi.mock('../data/db', async () => {
  const actual = await vi.importActual<typeof import('../data/db')>('../data/db')
  return {
    ...actual,
    getReviewsForChildInRange: vi.fn(() => Promise.resolve([])),
    getReviewsForChildChar: vi.fn(() => Promise.resolve([])),
  }
})

import { useHistory, useCharacterStats } from './useStats'

const SM2_A: SM2State = {
  ease: 2.5, interval: 1, repetitions: 1,
  nextReview: '2026-01-02', lastGrade: 'a',
  firstReviewDay: '2026-01-01',
}

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [{
      id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 1,
      progress: { '雨': SM2_A },
    }],
    wordBooks: [{ id: 'wb_1', name: '测试', characters: ['雨'] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    ...overrides,
  }
}

describe('useHistory', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls getReviewsForChildInRange on initial mount (no more getFirstReviewDays)', () => {
    renderHook(() => useHistory('child_1', '2026-06'), {
      wrapper: ({ children }: { children: ReactNode }) => {
        const ctx: AppContextState = {
          state: makeState(), loading: false, dataVersion: 0,
          selectedChildId: 'child_1', setSelectedChildId: vi.fn(), reloadState: vi.fn(),
          createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
          createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
          addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
          submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
          getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
        }
        return React.createElement(AppContext.Provider, { value: ctx }, children)
      },
    })
    expect(db.getReviewsForChildInRange).toHaveBeenCalledTimes(1)
  })

  it('skips re-query when past month sees only dataVersion bump', async () => {
    let setDV = (_: number) => {}
    function W({ children }: { children: ReactNode }) {
      const [dv, set] = useState(0)
      setDV = set
      const ctx: AppContextState = {
        state: makeState(), loading: false, dataVersion: dv,
        selectedChildId: 'child_1', setSelectedChildId: vi.fn(), reloadState: vi.fn(),
        createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
        createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
        addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
        submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
        getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
      }
      return React.createElement(AppContext.Provider, { value: ctx }, children)
    }

    renderHook(() => useHistory('child_1', '2026-06'), { wrapper: W })
    await vi.waitFor(() => { expect(db.getReviewsForChildInRange).toHaveBeenCalledTimes(1) })

    await act(async () => { setDV(1); await new Promise(r => setTimeout(r, 50)) })
    expect(db.getReviewsForChildInRange).toHaveBeenCalledTimes(1) // skipped
  })
})

describe('useCharacterStats', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('calls getReviewsForChildChar on initial mount', () => {
    renderHook(() => useCharacterStats('child_1', '雨'), {
      wrapper: ({ children }: { children: ReactNode }) => {
        const ctx: AppContextState = {
          state: makeState(), loading: false, dataVersion: 0,
          selectedChildId: 'child_1', setSelectedChildId: vi.fn(), reloadState: vi.fn(),
          createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
          createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
          addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
          submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
          getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
        }
        return React.createElement(AppContext.Provider, { value: ctx }, children)
      },
    })
    expect(db.getReviewsForChildChar).toHaveBeenCalledTimes(1)
  })

  it('skips re-query when dataVersion bumps but SM2State unchanged', async () => {
    let setDV = (_: number) => {}
    function W({ children }: { children: ReactNode }) {
      const [dv, set] = useState(0)
      setDV = set
      const ctx: AppContextState = {
        state: makeState(), loading: false, dataVersion: dv,
        selectedChildId: 'child_1', setSelectedChildId: vi.fn(), reloadState: vi.fn(),
        createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
        createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
        addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
        submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
        getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
      }
      return React.createElement(AppContext.Provider, { value: ctx }, children)
    }

    renderHook(() => useCharacterStats('child_1', '雨'), { wrapper: W })
    await vi.waitFor(() => { expect(db.getReviewsForChildChar).toHaveBeenCalledTimes(1) })

    await act(async () => { setDV(1); await new Promise(r => setTimeout(r, 50)) })
    expect(db.getReviewsForChildChar).toHaveBeenCalledTimes(1)
  })

  it('re-queries when SM2State actually changes', async () => {
    let setState = (_: AppState) => {}
    function W({ children }: { children: ReactNode }) {
      const [s, set] = useState(makeState())
      setState = set
      const ctx: AppContextState = {
        state: s, loading: false, dataVersion: 0,
        selectedChildId: 'child_1', setSelectedChildId: vi.fn(), reloadState: vi.fn(),
        createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
        createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
        addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
        submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
        getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
      }
      return React.createElement(AppContext.Provider, { value: ctx }, children)
    }

    renderHook(() => useCharacterStats('child_1', '雨'), { wrapper: W })
    await vi.waitFor(() => { expect(db.getReviewsForChildChar).toHaveBeenCalledTimes(1) })

    const updated = makeState()
    updated.children[0].progress['雨'] = { ...SM2_A, repetitions: 2 }
    await act(async () => { setState(updated); await new Promise(r => setTimeout(r, 50)) })
    expect(db.getReviewsForChildChar).toHaveBeenCalledTimes(2)
  })
})
