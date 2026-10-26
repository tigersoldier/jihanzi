/**
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getPinyin, getWords } from '../../utils/chars'
import CharacterCard from './CharacterCard'

vi.mock('../common/LearningCharacter', async () => {
  const React = await vi.importActual<typeof import('react')>('react')

  return {
    default: function MockLearningCharacter({
      character,
      onFontReadyChange,
    }: {
      character: string
      onFontReadyChange?: (character: string, isReady: boolean) => void
    }) {
      React.useEffect(() => {
        const timer = window.setTimeout(() => onFontReadyChange?.(character, true), 1500)
        return () => window.clearTimeout(timer)
      }, [character, onFontReadyChange])

      return <span aria-label={character}>{character}</span>
    },
  }
})

describe('CharacterCard 自动隐藏', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('隐藏时仍等待字体就绪，长按揭晓与冷却按时工作', () => {
    const onFontReadyChange = vi.fn()
    render(
      <CharacterCard character="草" isNew={false} autoHide onFontReadyChange={onFontReadyChange} />,
    )

    expect(screen.getByText('草')).toBeDefined()
    expect(screen.getByText(getPinyin('草'))).toBeDefined()
    const words = getWords('草')
    const maskedWords = words.map(word => word.split('草').join('～')).join(' · ')
    expect(words.length).toBeGreaterThan(0)
    expect(screen.getByText(maskedWords)).toBeDefined()
    act(() => vi.advanceTimersByTime(1000))

    const hiddenContent = screen.getByText('草').closest('[aria-hidden="true"]')
    expect(hiddenContent).not.toBeNull()
    expect(hiddenContent?.classList.contains('invisible')).toBe(true)
    expect(screen.getByText(getPinyin('草')).closest('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByText(maskedWords).closest('[aria-hidden="true"]')).not.toBeNull()
    act(() => vi.advanceTimersByTime(500))
    expect(onFontReadyChange).toHaveBeenCalledWith('草', true)
    const revealButton = screen.getByRole('button', { name: /长按显示生字/ })
    expect(revealButton.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('3 秒后可再次显示')).toBeDefined()

    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('2 秒后可再次显示')).toBeDefined()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('1 秒后可再次显示')).toBeDefined()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button', { name: '长按显示生字' }).hasAttribute('disabled')).toBe(
      false,
    )

    const enabledRevealButton = screen.getByRole('button', { name: '长按显示生字' })
    fireEvent.pointerDown(enabledRevealButton, { clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(100))
    fireEvent.pointerMove(enabledRevealButton, { clientX: 21, clientY: 10 })
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByText('草').closest('[aria-hidden="true"]')).not.toBeNull()
    fireEvent.pointerUp(enabledRevealButton)

    fireEvent.pointerDown(enabledRevealButton, { clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(499))
    expect(screen.getByText('草').closest('[aria-hidden="true"]')).not.toBeNull()
    fireEvent.pointerUp(enabledRevealButton)
    fireEvent.click(enabledRevealButton, { detail: 1 })
    expect(screen.getByText('草').closest('[aria-hidden="true"]')).not.toBeNull()

    fireEvent.pointerDown(enabledRevealButton, { clientX: 10, clientY: 10 })
    act(() => vi.advanceTimersByTime(500))
    expect(screen.getByText('草').closest('[aria-hidden="true"]')).toBeNull()
    fireEvent.pointerUp(enabledRevealButton)
    act(() => vi.advanceTimersByTime(1000))

    expect(screen.getByText('草').closest('[aria-hidden="true"]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /长按显示生字/ }).hasAttribute('disabled')).toBe(true)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button', { name: /长按显示生字/ }).hasAttribute('disabled')).toBe(true)
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button', { name: /长按显示生字/ }).hasAttribute('disabled')).toBe(true)
    act(() => vi.advanceTimersByTime(999))
    expect(screen.getByRole('button', { name: /长按显示生字/ }).hasAttribute('disabled')).toBe(true)
    act(() => vi.advanceTimersByTime(1))
    expect(screen.getByRole('button', { name: '长按显示生字' }).hasAttribute('disabled')).toBe(
      false,
    )
  })

  it('复习卡片展示词组时将当前字替换为全角波浪号', () => {
    render(<CharacterCard character="蜗" isNew={false} />)

    expect(screen.getByText('～牛 · ～牛壳 · ～居')).toBeDefined()
  })

  it('词例中重复出现的当前字也全部替换', () => {
    const words = getWords('爸')
    const maskedWords = words.map(word => word.split('爸').join('～')).join(' · ')
    render(<CharacterCard character="爸" isNew={false} />)

    expect(maskedWords).toContain('～～')
    expect(screen.getByText(maskedWords)).toBeDefined()
    expect(screen.queryByText(words.join(' · '))).toBeNull()
  })

  it('切换到新任务时重新显示新字', () => {
    const { rerender } = render(<CharacterCard key="一" character="一" isNew={false} autoHide />)

    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('一').closest('[aria-hidden="true"]')).not.toBeNull()

    rerender(<CharacterCard key="二" character="二" isNew={false} autoHide />)
    expect(screen.getByText('二').closest('[aria-hidden="true"]')).toBeNull()
  })

  it('普通展示卡片不自动隐藏', () => {
    render(<CharacterCard character="花" isNew={false} />)

    act(() => vi.advanceTimersByTime(5000))

    expect(screen.getByText('花')).toBeDefined()
    expect(screen.queryByRole('button', { name: /长按显示生字/ })).toBeNull()
  })
})
