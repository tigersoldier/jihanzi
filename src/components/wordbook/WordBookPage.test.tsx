// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import WordBookPage from './WordBookPage'

const { mockUseApp, mockUseWordBook, mockUseCharacterStats } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
  mockUseWordBook: vi.fn(),
  mockUseCharacterStats: vi.fn(),
}))

vi.mock('../../state/AppContext', () => ({ useApp: mockUseApp }))
vi.mock('../../hooks/useWordBook', () => ({ useWordBook: mockUseWordBook }))
vi.mock('../../hooks/useStats', () => ({ useCharacterStats: mockUseCharacterStats }))

describe('WordBookPage', () => {
  beforeEach(() => {
    window.location.hash = '#/wordbook/wb/wb-1'

    mockUseApp.mockReturnValue({
      state: {
        children: [
          {
            id: 'child-1',
            name: '孩子',
            wordBookId: 'wb-1',
            nextCharIndex: 0,
            progress: {},
          },
        ],
        wordBooks: [{ id: 'wb-1', name: '测试生字本', characters: ['花'] }],
      },
      selectedChildId: 'child-1',
      setSelectedChildId: vi.fn(),
    })
    mockUseWordBook.mockReturnValue({
      selectedWBId: 'wb-1',
      setSelectedWBId: vi.fn(),
      wbList: [{ id: 'wb-1', name: '测试生字本', characters: ['花'] }],
      currentWB: { id: 'wb-1', name: '测试生字本', characters: ['花'] },
      addCharacter: vi.fn(),
      removeCharacter: vi.fn(),
      reorderCharacters: vi.fn(),
      createWB: vi.fn(),
    })
    mockUseCharacterStats.mockReturnValue({
      sm2State: null,
      totalReviews: 0,
      gradeCounts: { a: 0, b: 0, c: 0, d: 0 },
      latestGrade: null,
      timeline: [],
      loading: false,
      hasMore: false,
      loadingMore: false,
      loadMore: vi.fn(),
    })

    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: (x: number | ScrollToOptions, y?: number) => {
        document.documentElement.scrollTop = typeof x === 'number' ? (y ?? 0) : (x.top ?? 0)
      },
    })
  })

  it('打开生字详情时滚动回页面顶部', async () => {
    render(<WordBookPage />)
    document.documentElement.scrollTop = 480

    fireEvent.click(screen.getByText('花'))

    expect(await screen.findByText(/学习统计/)).toBeTruthy()
    expect(document.documentElement.scrollTop).toBe(0)
  })
})
