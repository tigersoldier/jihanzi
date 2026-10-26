// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatReviewDueLabel } from '../../utils/date'
import WordBookPage from './WordBookPage'

const { mockUseApp, mockUseWordBook, mockUseCharacterStats, mockUseReviewCounts } = vi.hoisted(
  () => ({
    mockUseApp: vi.fn(),
    mockUseWordBook: vi.fn(),
    mockUseCharacterStats: vi.fn(),
    mockUseReviewCounts: vi.fn(),
  }),
)

vi.mock('../../state/AppContextDefinition', () => ({ useApp: mockUseApp }))
vi.mock('../../hooks/useWordBook', () => ({ useWordBook: mockUseWordBook }))
vi.mock('../../hooks/useStats', () => ({ useCharacterStats: mockUseCharacterStats }))
vi.mock('../../hooks/useWordBookReviewCounts', () => ({
  useWordBookReviewCounts: mockUseReviewCounts,
}))

function mockLearnedCharacterState() {
  mockUseApp.mockReturnValue({
    state: {
      children: [
        {
          id: 'child-1',
          name: '孩子',
          wordBookId: 'wb-1',
          nextCharIndex: 0,
          progress: {
            花: {
              ease: 2.5,
              interval: 3,
              repetitions: 2,
              nextReview: '2026-06-08',
              lastGrade: 'a',
              firstReviewDay: '2026-06-05',
            },
          },
        },
      ],
      wordBooks: [{ id: 'wb-1', name: '测试生字本', characters: ['花'] }],
    },
    selectedChildId: 'child-1',
    setSelectedChildId: vi.fn(),
  })
}

describe('WordBookPage', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

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
    mockUseReviewCounts.mockReturnValue({ status: 'ready', counts: {} })
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

  it('按复习次数排序并可筛选薄弱字，排序时关闭手动拖动', () => {
    const characters = ['山', '花', '雨', '水']
    const progress = {
      花: {
        ease: 2.5,
        interval: 8,
        repetitions: 3,
        nextReview: '2026-06-08',
        lastGrade: 'a',
        firstReviewDay: '2026-05-01',
      },
      山: {
        ease: 2.5,
        interval: 1,
        repetitions: 0,
        nextReview: '2026-06-02',
        lastGrade: 'd',
        firstReviewDay: '2026-05-02',
      },
      水: {
        ease: 2.5,
        interval: 2,
        repetitions: 1,
        nextReview: '2026-06-05',
        lastGrade: 'b',
        firstReviewDay: '2026-05-03',
      },
    } as const
    const wordBook = { id: 'wb-1', name: '测试生字本', characters }
    mockUseApp.mockReturnValue({
      state: {
        children: [{ id: 'child-1', name: '孩子', wordBookId: 'wb-1', nextCharIndex: 0, progress }],
        wordBooks: [wordBook],
      },
      selectedChildId: 'child-1',
      setSelectedChildId: vi.fn(),
    })
    mockUseWordBook.mockReturnValue({
      selectedWBId: 'wb-1',
      setSelectedWBId: vi.fn(),
      wbList: [{ id: 'wb-1', name: '测试生字本', count: characters.length }],
      currentWB: wordBook,
      addCharacter: vi.fn(),
      removeCharacter: vi.fn(),
      reorderCharacters: vi.fn(),
      createWB: vi.fn(),
    })
    mockUseReviewCounts.mockReturnValue({ status: 'ready', counts: { 花: 9, 山: 4, 水: 4 } })

    render(<WordBookPage />)

    const sortSelect = screen.getByLabelText('排序汉字')
    const listedCharacters = () =>
      screen
        .getAllByRole('button', { name: /^删除 / })
        .map(button => button.getAttribute('aria-label')?.replace('删除 ', ''))
    expect((sortSelect as HTMLSelectElement).value).toBe('manual')
    expect(listedCharacters()).toEqual(['山', '花', '雨', '水'])
    const flowerInfo = screen.getByRole('group', { name: '花学习信息' })
    expect(flowerInfo.textContent).toContain('9次·')
    expect(flowerInfo.textContent).toContain(formatReviewDueLabel('2026-06-08'))
    expect(flowerInfo.className).toContain('whitespace-nowrap')
    expect(flowerInfo.parentElement?.className).toContain('items-center')
    expect(screen.queryByRole('group', { name: '雨学习信息' })).toBeNull()

    fireEvent.change(sortSelect, { target: { value: 'nextReview' } })
    const directionSelect = screen.getByLabelText('排序方向') as HTMLSelectElement
    expect(directionSelect.value).toBe('asc')
    expect(listedCharacters()).toEqual(['山', '水', '花', '雨'])
    expect(screen.queryByLabelText('拖动排序')).toBeNull()

    fireEvent.change(directionSelect, { target: { value: 'desc' } })
    expect(listedCharacters()).toEqual(['花', '水', '山', '雨'])

    fireEvent.change(sortSelect, { target: { value: 'reviewCount' } })
    expect((screen.getByLabelText('排序方向') as HTMLSelectElement).value).toBe('desc')
    expect(listedCharacters()).toEqual(['花', '山', '水', '雨'])
    expect(screen.queryByLabelText('拖动排序')).toBeNull()

    fireEvent.change(screen.getByLabelText('排序方向'), { target: { value: 'asc' } })
    expect(listedCharacters()).toEqual(['山', '水', '花', '雨'])
    fireEvent.change(sortSelect, { target: { value: 'nextReview' } })
    expect((screen.getByLabelText('排序方向') as HTMLSelectElement).value).toBe('desc')
    expect(listedCharacters()).toEqual(['花', '水', '山', '雨'])

    fireEvent.change(screen.getByLabelText('按熟悉程度筛选'), {
      target: { value: 'weak' },
    })
    expect(listedCharacters()).toEqual(['山'])
  })

  it('首次读取计数时行内显示读取状态且不伪装为零次', () => {
    mockLearnedCharacterState()
    mockUseReviewCounts.mockReturnValue({ status: 'loading', counts: {} })
    render(<WordBookPage />)

    const flowerInfo = screen.getByRole('group', { name: '花学习信息' })
    expect(flowerInfo.textContent).toContain('次数读取中')
    expect(flowerInfo.textContent).not.toContain('0次')
    expect(screen.getByText(/正在读取复习次数，复习次数排序暂不可用/)).toBeTruthy()
    const sortSelect = screen.getByLabelText('排序汉字') as HTMLSelectElement
    expect(sortSelect.querySelector('option[value="reviewCount"]')?.hasAttribute('disabled')).toBe(
      true,
    )
  })

  it('计数读取失败时行内显示不可用状态且不伪装为零次', () => {
    mockLearnedCharacterState()
    mockUseReviewCounts.mockReturnValue({ status: 'ready', counts: { 花: 1 } })
    const { rerender } = render(<WordBookPage />)
    fireEvent.change(screen.getByLabelText('排序汉字'), { target: { value: 'reviewCount' } })

    mockUseReviewCounts.mockReturnValue({ status: 'unavailable', counts: {} })
    rerender(<WordBookPage />)

    expect(screen.getByText(/复习次数暂不可用/)).toBeTruthy()
    const flowerInfo = screen.getByRole('group', { name: '花学习信息' })
    expect(flowerInfo.textContent).toContain('次数不可用')
    expect(flowerInfo.textContent).not.toContain('0次')
    const sortSelect = screen.getByLabelText('排序汉字') as HTMLSelectElement
    expect(sortSelect.value).toBe('reviewCount')
    expect(sortSelect.querySelector('option[value="reviewCount"]')?.hasAttribute('disabled')).toBe(
      true,
    )
    expect(screen.getByLabelText('拖动排序')).toBeTruthy()
  })

  it('跨过本地零点后刷新行内复习倒计时', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 7, 23, 59, 59, 900))
    mockLearnedCharacterState()
    mockUseReviewCounts.mockReturnValue({ status: 'ready', counts: { 花: 9 } })
    render(<WordBookPage />)

    const getFlowerInfo = () => screen.getByRole('group', { name: '花学习信息' })
    expect(getFlowerInfo().textContent).toContain('下次1天后')

    act(() => vi.advanceTimersByTime(200))

    expect(getFlowerInfo().textContent).toContain('下次今天')
  })

  it('页面重新可见时重新计算复习倒计时', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 5, 7, 12))
    mockLearnedCharacterState()
    mockUseReviewCounts.mockReturnValue({ status: 'ready', counts: { 花: 9 } })
    render(<WordBookPage />)

    const flowerInfo = screen.getByRole('group', { name: '花学习信息' })
    expect(flowerInfo.textContent).toContain('下次1天后')

    vi.setSystemTime(new Date(2026, 5, 8, 1))
    act(() => document.dispatchEvent(new Event('visibilitychange')))

    expect(flowerInfo.textContent).toContain('下次今天')
  })

  it('打开生字详情时滚动回页面顶部', async () => {
    render(<WordBookPage />)
    document.documentElement.scrollTop = 480

    fireEvent.click(screen.getByText('花'))

    expect(await screen.findByText(/学习统计/)).toBeTruthy()
    expect(document.documentElement.scrollTop).toBe(0)
  })
})
