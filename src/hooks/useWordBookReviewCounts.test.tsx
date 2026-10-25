// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockUseApp, mockGetReviewCountsForChild } = vi.hoisted(() => ({
  mockUseApp: vi.fn(),
  mockGetReviewCountsForChild: vi.fn(),
}))

vi.mock('../state/AppContext', () => ({ useApp: mockUseApp }))
vi.mock('../data/db', () => ({
  getReviewCountsForChild: (...args: unknown[]) => mockGetReviewCountsForChild(...args),
}))

import { useWordBookReviewCounts } from './useWordBookReviewCounts'

describe('useWordBookReviewCounts', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    mockUseApp.mockReset().mockReturnValue({ dataVersion: 0 })
    mockGetReviewCountsForChild.mockReset()
  })

  it('reports migration failures as unavailable instead of zero counts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    mockGetReviewCountsForChild.mockRejectedValue(new Error('count migration failed'))

    const { result } = renderHook(() => useWordBookReviewCounts('child-a'))
    await waitFor(() => expect(result.current.status).toBe('unavailable'))

    expect(result.current.counts).toEqual({})
    expect(mockGetReviewCountsForChild).toHaveBeenCalledWith('child-a')
  })

  it('reloads counts when imported or synchronized data changes', async () => {
    let dataVersion = 0
    mockUseApp.mockImplementation(() => ({ dataVersion }))
    mockGetReviewCountsForChild.mockResolvedValueOnce({ 花: 2 }).mockResolvedValueOnce({ 花: 3 })

    const { result, rerender } = renderHook(() => useWordBookReviewCounts('child-a'))
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', counts: { 花: 2 } }))

    dataVersion++
    rerender()
    await waitFor(() => expect(result.current).toEqual({ status: 'ready', counts: { 花: 3 } }))
    expect(mockGetReviewCountsForChild).toHaveBeenCalledTimes(2)
  })
})
