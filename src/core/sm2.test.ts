import { describe, it, expect } from 'vitest'
import { updateSM2, createInitialSM2State } from './sm2'
import { MAX_SANE_INTERVAL_DAYS } from './sm2'

describe('updateSM2', () => {
  it('连续高分复习时 interval 不超过上限（防御重复应用导致的爆炸）', () => {
    // 模拟重复应用同一复习 60 次（同步重复条目的最坏情况）
    let state = createInitialSM2State('2026-01-01')
    for (let i = 0; i < 60; i++) {
      state = updateSM2(state, 'a', '2026-01-01')
    }
    expect(state.interval).toBeLessThanOrEqual(MAX_SANE_INTERVAL_DAYS)
    expect(Number.isFinite(state.interval)).toBe(true)
  })

  it('正常复习链不受上限影响', () => {
    let state = createInitialSM2State('2026-01-01')
    for (let i = 0; i < 8; i++) {
      state = updateSM2(state, 'a', '2026-01-01')
    }
    // 8 次 a 评级：1→3→8→22→64→192→595→1904→6283，远低于上限
    expect(state.interval).toBe(6283)
    expect(state.interval).toBeLessThan(MAX_SANE_INTERVAL_DAYS)
  })

  it('d 评级重置后 interval 回到 1 天', () => {
    let state = createInitialSM2State('2026-01-01')
    state = updateSM2(state, 'a', '2026-01-01')
    state = updateSM2(state, 'd', '2026-01-02')
    expect(state.interval).toBe(1)
    expect(state.ease).toBe(2.5)
    expect(state.repetitions).toBe(0)
  })
})
