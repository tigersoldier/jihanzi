/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import LearningCharacter from './LearningCharacter'

const { mockLoadLearningKaiFont } = vi.hoisted(() => ({
  mockLoadLearningKaiFont: vi.fn(),
}))

vi.mock('../../utils/learningFont', () => ({
  loadLearningKaiFont: mockLoadLearningKaiFont,
}))

beforeEach(() => {
  mockLoadLearningKaiFont.mockReset().mockResolvedValue(undefined)
})

afterEach(cleanup)

describe('LearningCharacter', () => {
  it('only renders a supported character after the embedded font loads', async () => {
    const onFontReadyChange = vi.fn()
    render(
      <LearningCharacter
        character="学"
        className="text-7xl"
        onFontReadyChange={onFontReadyChange}
      />,
    )

    expect(await screen.findByText('学')).toHaveClass('font-learning-kai', 'text-7xl')
    expect(mockLoadLearningKaiFont).toHaveBeenCalledWith('学')
    expect(onFontReadyChange).toHaveBeenNthCalledWith(1, '学', false)
    expect(onFontReadyChange).toHaveBeenNthCalledWith(2, '学', true)
  })

  it('does not render unsupported glyphs with a system-font fallback', () => {
    render(<LearningCharacter character="乊" />)

    expect(screen.getByRole('alert')).toHaveTextContent('该字暂未收录于楷体字库')
    expect(screen.queryByText('乊')).not.toBeInTheDocument()
    expect(mockLoadLearningKaiFont).not.toHaveBeenCalled()
  })

  it('keeps the character hidden when font loading fails and allows retry', async () => {
    mockLoadLearningKaiFont.mockRejectedValueOnce(new Error('network error'))
    render(<LearningCharacter character="学" />)

    expect(await screen.findByRole('alert')).toHaveTextContent('楷体加载失败')
    expect(screen.queryByText('学')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '点击重试' }))
    expect(await screen.findByText('学')).toBeInTheDocument()
  })
})
