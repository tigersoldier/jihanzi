/**
 * @vitest-environment jsdom
 *
 * Tests for useRoute — URL hash driven routing hook.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useRoute } from './useRoute'

describe('useRoute', () => {
  beforeEach(() => {
    window.location.hash = ''
  })

  it('初始路由从当前 hash 解析', () => {
    window.location.hash = '#/wordbook/char/花'
    const { result } = renderHook(() => useRoute())
    expect(result.current.route).toEqual({ name: 'wordbook', char: '花' })
  })

  it('navigate push 写入 hash 并同步路由', async () => {
    const { result } = renderHook(() => useRoute())

    act(() => {
      result.current.navigate({ name: 'child' })
    })

    expect(window.location.hash).toBe('#/child')
    // hashchange 事件异步触发，路由随之更新
    await waitFor(() => expect(result.current.route).toEqual({ name: 'child' }))
  })

  it('navigate 相同路由不产生重复记录', () => {
    const { result } = renderHook(() => useRoute())

    act(() => {
      result.current.navigate({ name: 'progress' })
    })

    // 初始 hash 为空 → 目标 '#/progress' 不同 → 会写入
    expect(window.location.hash).toBe('#/progress')

    const lengthAfterPush = window.history.length
    act(() => {
      result.current.navigate({ name: 'progress' })
    })

    // 相同 hash → no-op，不新增历史记录
    expect(window.history.length).toBe(lengthAfterPush)
  })

  it('navigate replace 不新增历史记录', () => {
    const { result } = renderHook(() => useRoute())
    const lengthBefore = window.history.length

    act(() => {
      result.current.navigate({ name: 'child' }, { replace: true })
    })

    expect(window.location.hash).toBe('#/child')
    expect(window.history.length).toBe(lengthBefore)
  })

  // jsdom 环境的历史记录并非从 1 开始（vitest 环境自带若干条），
  // 因此用 spy 固定 length 来测回退分支
  it('无历史可退时 goBack 回退到 fallback 路由（replace，不新增记录）', () => {
    const lengthSpy = vi.spyOn(window.history, 'length', 'get').mockReturnValue(1)
    const { result } = renderHook(() => useRoute())

    act(() => {
      result.current.goBack({ name: 'progress', month: '2026-08' })
    })

    expect(window.location.hash).toBe('#/progress/2026-08')
    lengthSpy.mockRestore()
  })

  it('有历史可退时 goBack 调用 history.back()', () => {
    const backSpy = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const lengthSpy = vi.spyOn(window.history, 'length', 'get').mockReturnValue(5)
    const { result } = renderHook(() => useRoute())

    act(() => {
      result.current.goBack({ name: 'progress' })
    })

    expect(backSpy).toHaveBeenCalled()
    expect(window.location.hash).toBe('') // history.back 被 mock，hash 不变
    backSpy.mockRestore()
    lengthSpy.mockRestore()
  })
})
