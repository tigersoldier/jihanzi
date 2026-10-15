/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import ProgressBar from './ProgressBar'

afterEach(cleanup)

function getProgressWidth(current: number, total: number) {
  const { container } = render(<ProgressBar current={current} total={total} />)
  const fill = container.querySelector('.bg-indigo-500')
  expect(fill).not.toBeNull()
  return (fill as HTMLElement).style.width
}

describe('ProgressBar', () => {
  it('starts at 0% for the first task', () => {
    expect(getProgressWidth(0, 3)).toBe('0%')
  })

  it('reaches 100% for the last task', () => {
    expect(getProgressWidth(2, 3)).toBe('100%')
  })

  it('handles a single task and an empty task list', () => {
    expect(getProgressWidth(0, 1)).toBe('100%')
    expect(getProgressWidth(0, 0)).toBe('0%')
  })
})
