import { describe, it, expect } from 'vitest'
import { applyEntry, replayLog, createSnapshot } from './log'
import type { AppState, Snapshot, AnyLogEntry, ReviewEntry } from './types'

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [],
    wordBooks: [],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    ...overrides,
  }
}

describe('applyEntry — return value', () => {
  it('returns false for consolidation rounds (round !== 1)', () => {
    const state = makeState({
      children: [
        {
          id: 'child_1', name: '小明', wordBookId: 'wb_1',
          nextCharIndex: 0, progress: {},
        },
      ],
      wordBooks: [
        { id: 'wb_1', name: '测试', characters: ['花'] },
      ],
    })

    const round2: ReviewEntry = {
      timestamp: 1, type: 'review', childId: 'child_1',
      character: '花', grade: 'c', round: 2, dayKey: '2026-07-01',
    }
    const changed = applyEntry(state, round2)
    expect(changed).toBe(false)
  })

  it('returns true for round 1 review (new character)', () => {
    const state = makeState({
      children: [
        {
          id: 'child_1', name: '小明', wordBookId: 'wb_1',
          nextCharIndex: 0, progress: {},
        },
      ],
      wordBooks: [
        { id: 'wb_1', name: '测试', characters: ['花'] },
      ],
    })

    const round1: ReviewEntry = {
      timestamp: 1, type: 'review', childId: 'child_1',
      character: '花', grade: 'a', round: 1, dayKey: '2026-07-01',
    }
    const changed = applyEntry(state, round1)
    expect(changed).toBe(true)
    expect(state.children[0].progress['花']).toBeDefined()
    // firstReviewDay materialised for new characters
    expect(state.children[0].progress['花'].firstReviewDay).toBe('2026-07-01')
  })

  it('returns false when update_child has no real changes', () => {
    const state = makeState({
      children: [
        {
          id: 'child_1', name: '小明', wordBookId: 'wb_1',
          nextCharIndex: 0, progress: {},
        },
      ],
    })

    const noop = {
      timestamp: 1, type: 'update_child' as const,
      childId: 'child_1', name: undefined, wordBookId: undefined,
    }
    expect(applyEntry(state, noop)).toBe(false)

    const sameName = {
      timestamp: 2, type: 'update_child' as const,
      childId: 'child_1', name: '小明',
    }
    expect(applyEntry(state, sameName)).toBe(false)
  })

  it('returns true when update_child actually changes', () => {
    const state = makeState({
      children: [
        {
          id: 'child_1', name: '小明', wordBookId: 'wb_1',
          nextCharIndex: 0, progress: {},
        },
      ],
    })

    const change = {
      timestamp: 1, type: 'update_child' as const,
      childId: 'child_1', name: '大明',
    }
    expect(applyEntry(state, change)).toBe(true)
    expect(state.children[0].name).toBe('大明')
  })

  it('returns false when reorder_chars has same order', () => {
    const state = makeState({
      wordBooks: [
        { id: 'wb_1', name: '测试', characters: ['花', '一', '二'] },
      ],
    })

    const noop = {
      timestamp: 1, type: 'reorder_chars' as const,
      wordBookId: 'wb_1', characters: ['花', '一', '二'],
    }
    expect(applyEntry(state, noop)).toBe(false)
  })

  it('returns true when reorder_chars actually changes', () => {
    const state = makeState({
      wordBooks: [
        { id: 'wb_1', name: '测试', characters: ['花', '一', '二'] },
      ],
    })

    const change = {
      timestamp: 1, type: 'reorder_chars' as const,
      wordBookId: 'wb_1', characters: ['二', '一', '花'],
    }
    expect(applyEntry(state, change)).toBe(true)
    expect(state.wordBooks[0].characters).toEqual(['二', '一', '花'])
  })

  it('returns false when update_settings has no real changes', () => {
    const state = makeState()

    const noop = {
      timestamp: 1, type: 'update_settings' as const,
      settings: { dailyReviewLimit: 30 },
    }
    expect(applyEntry(state, noop)).toBe(false)
  })

  it('returns true when update_settings actually changes', () => {
    const state = makeState()

    const change = {
      timestamp: 1, type: 'update_settings' as const,
      settings: { dailyReviewLimit: 50 },
    }
    expect(applyEntry(state, change)).toBe(true)
    expect(state.settings.dailyReviewLimit).toBe(50)
  })
})

describe('createSnapshot', () => {
  it('creates a snapshot with a timestamp that captures current state', () => {
    const state = makeState({
      children: [
        {
          id: 'child_1', name: '小明', wordBookId: 'wb_1',
          nextCharIndex: 3, progress: {},
        },
      ],
    })

    const snap = createSnapshot(state)
    expect(snap.timestamp).toBeGreaterThan(0)
    expect(snap.state.children[0].name).toBe('小明')
    // Snapshot is a deep clone — mutating original doesn't affect it
    state.children[0].name = '改变后的名字'
    expect(snap.state.children[0].name).toBe('小明')
  })
})

describe('replayLog', () => {
  it('replays log against snapshot to reconstruct full state', () => {
    const snapshot: Snapshot = {
      timestamp: 0,
      state: makeState({
        children: [
          {
            id: 'child_1', name: '小明', wordBookId: 'wb_1',
            nextCharIndex: 0, progress: {},
          },
        ],
        wordBooks: [
          { id: 'wb_1', name: '测试', characters: ['花'] },
        ],
      }),
    }

    const logs: AnyLogEntry[] = [
      {
        timestamp: 1, type: 'review', childId: 'child_1',
        character: '花', grade: 'a', round: 1, dayKey: '2026-07-01',
      },
    ]

    const state = replayLog(snapshot, logs)
    expect(state.children[0].progress['花']).toBeDefined()
    expect(state.children[0].progress['花'].firstReviewDay).toBe('2026-07-01')
  })

  it('handles null snapshot (fresh start)', () => {
    const logs: AnyLogEntry[] = [
      {
        timestamp: 1, type: 'create_child',
        childId: 'child_x', name: '大明', wordBookId: 'wb_x',
      },
    ]

    const state = replayLog(null, logs)
    expect(state.children).toHaveLength(1)
    expect(state.children[0].name).toBe('大明')
  })
})
