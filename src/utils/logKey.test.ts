import { describe, it, expect } from 'vitest'
import { makeDiffKey, dedupeLogEntries } from './logKey'
import type { AnyLogEntry } from '../core/types'

const review = (timestamp: number, character: string, grade = 'a'): AnyLogEntry => ({
  timestamp,
  type: 'review',
  childId: 'child_1',
  character,
  grade: grade as AnyLogEntry['grade'],
  round: 1,
  dayKey: '2026-07-01',
})

describe('makeDiffKey', () => {
  it('review 条目使用 timestamp + childId + character 作为去重键', () => {
    const a = review(100, '花')
    const b = { ...review(100, '花'), grade: 'b' }
    const c = review(100, '山')
    expect(makeDiffKey(a)).toBe(makeDiffKey(b))
    expect(makeDiffKey(a)).not.toBe(makeDiffKey(c))
  })
})

describe('dedupeLogEntries', () => {
  it('按 makeDiffKey 去重，保留首次出现的条目', () => {
    const first = review(100, '花', 'a')
    const dup = review(100, '花', 'b') // 同 key（timestamp+childId+character），不同 grade
    const other = review(200, '山')
    const result = dedupeLogEntries([first, dup, other])
    expect(result).toEqual([first, other])
  })

  it('保持输入顺序稳定', () => {
    const entries = [review(300, '山'), review(100, '花'), review(100, '花'), review(200, '水')]
    const result = dedupeLogEntries(entries)
    expect(result).toEqual([review(300, '山'), review(100, '花'), review(200, '水')])
  })

  it('不同键的条目全部保留（包括相同 timestamp 的不同字符）', () => {
    const entries = [review(100, '花'), review(100, '山'), review(100, '水')]
    expect(dedupeLogEntries(entries)).toHaveLength(3)
  })

  it('空输入返回空数组', () => {
    expect(dedupeLogEntries([])).toEqual([])
  })
})
