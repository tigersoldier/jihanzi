/**
 * @vitest-environment jsdom
 *
 * Tests for useHistory — verifies that past-month queries skip
 * expensive re-scans when only dataVersion changes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React, { useState, type ReactNode } from 'react'
import type { AppState } from '../core/types'
import { AppContext, type AppContextState } from '../state/AppContext'
import * as db from '../data/db'

vi.mock('../data/db', async () => {
  const actual = await vi.importActual<typeof import('../data/db')>('../data/db')
  return { ...actual, getFirstReviewDays: vi.fn(() => Promise.resolve(new Map())), getReviewsForChildInRange: vi.fn(() => Promise.resolve([])) }
})

import { useHistory } from './useStats'

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [{ id: 'child_1', name: '小明', wordBookId: 'wb_1', nextCharIndex: 0, progress: {} }],
    wordBooks: [{ id: 'wb_1', name: '测试', characters: [] }],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    ...overrides,
  }
}

/** Stateful wrapper whose dataVersion can be bumped to simulate syncs */
function StatefulWrapper({ children, initialDV }: { children: ReactNode; initialDV: number }) {
  const [state] = useState<AppState>(makeState())
  const [dataVersion, setDataVersion] = useState(initialDV)

  const bump = () => setDataVersion(v => v + 1)

  // Expose bump via a ref stored on the wrapper element
  const contextValue: AppContextState & { _bump: () => void } = {
    state, loading: false, dataVersion,
    selectedChildId: 'child_1', setSelectedChildId: vi.fn(),
    reloadState: vi.fn(),
    createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
    createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
    addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
    submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
    getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
    _bump: bump,
  }
  return React.createElement(
    AppContext.Provider,
    { value: contextValue as AppContextState },
    children,
  )
}

describe('useHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('calls getFirstReviewDays on initial mount', () => {
    renderHook(() => useHistory('child_1', '2026-06'), {
      wrapper: ({ children }: { children: ReactNode }) =>
        React.createElement(StatefulWrapper, { initialDV: 0, children }),
    })
    expect(db.getFirstReviewDays).toHaveBeenCalledTimes(1)
  })

  it('skips getFirstReviewDays when past month sees only dataVersion bump', async () => {
    let bumpFn = () => {}

    function TestWrapper({ children }: { children: ReactNode }) {
      const [state] = useState<AppState>(makeState())
      const [dataVersion, setDataVersion] = useState(0)
      bumpFn = () => setDataVersion(v => v + 1)

      const ctx: AppContextState = {
        state, loading: false, dataVersion,
        selectedChildId: 'child_1', setSelectedChildId: vi.fn(),
        reloadState: vi.fn(),
        createChild: vi.fn() as any, updateChild: vi.fn() as any, deleteChild: vi.fn() as any,
        createWordBook: vi.fn() as any, updateWordBook: vi.fn() as any, deleteWordBook: vi.fn() as any,
        addCharacter: vi.fn() as any, removeCharacter: vi.fn() as any, reorderCharacters: vi.fn() as any,
        submitReview: vi.fn() as any, updateSettings: vi.fn() as any,
        getLogEntries: vi.fn() as any, bulkImport: vi.fn() as any,
      }
      return React.createElement(AppContext.Provider, { value: ctx }, children)
    }

    renderHook(() => useHistory('child_1', '2026-06'), { wrapper: TestWrapper })

    await vi.waitFor(() => {
      expect(db.getFirstReviewDays).toHaveBeenCalledTimes(1)
    })

    // Simulate sync — bump dataVersion
    await act(async () => { bumpFn() })
    // Flush effects
    await new Promise(r => setTimeout(r, 50))

    // Past month — should still be 1 call (skipped the re-scan)
    expect(db.getFirstReviewDays).toHaveBeenCalledTimes(1)
  })
})
