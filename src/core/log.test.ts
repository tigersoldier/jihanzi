import { describe, it, expect } from 'vitest'
import { replayLog } from './log'
import type { AppState, Snapshot } from './types'

function makeSnapshot(state: AppState): Snapshot {
  return { timestamp: 0, state }
}

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [],
    wordBooks: [],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    ...overrides,
  }
}

describe('replayLog', () => {
  it('评审后保留已有的孩子、生字本和设置', () => {
    // Given: a snapshot with one child and one word book
    const before = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '人教版一年级上册',
          characters: ['花', '一', '二'],
        },
      ],
    })

    const reviewEntry = {
      timestamp: 1,
      type: 'review' as const,
      childId: 'child_1',
      character: '花',
      grade: 'a' as const,
      round: 1,
      dayKey: '2026-06-28',
    }

    // When: replaying the review entry against the snapshot
    const after = replayLog(makeSnapshot(before), [reviewEntry])

    // Then: the child is still there
    expect(after.children).toHaveLength(1)
    expect(after.children[0].id).toBe('child_1')
    expect(after.children[0].name).toBe('小明')

    // Then: the word book is still there
    expect(after.wordBooks).toHaveLength(1)
    expect(after.wordBooks[0].id).toBe('wb_1')
    expect(after.wordBooks[0].name).toBe('人教版一年级上册')

    // Then: settings are still the defaults
    expect(after.settings.dailyReviewLimit).toBe(30)
  })

  it('第 1 轮评审后孩子的 SM-2 progress 被正确更新', () => {
    const before = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 0,
          progress: {},
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '人教版一年级上册',
          characters: ['花'],
        },
      ],
    })

    // 新字「花」第一次评审，评为 a
    const after = replayLog(makeSnapshot(before), [
      {
        timestamp: 1,
        type: 'review' as const,
        childId: 'child_1',
        character: '花',
        grade: 'a' as const,
        round: 1,
        dayKey: '2026-06-28',
      },
    ])

    // 「花」字应该出现在孩子的 progress 中
    const progress = after.children[0].progress['花']
    expect(progress).toBeDefined()
    // a 级评分会得到 ease≈2.6, interval>1
    expect(progress.ease).toBeGreaterThan(2.5)
    expect(progress.interval).toBeGreaterThan(1)
    // nextReview 应该在未来
    expect(progress.nextReview).toBeDefined()
    expect(progress.nextReview).not.toBe('2026-06-28')
  })

  it('第 2/3 轮评分不改变 SM-2 长期记忆状态', () => {
    const before = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 1,
          progress: {
            '花': {
              ease: 2.5,
              interval: 3,
              repetitions: 2,
              nextReview: '2026-06-30',
              lastGrade: 'a',
            },
          },
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '人教版一年级上册',
          characters: ['花'],
        },
      ],
    })

    // 巩固轮评为 d（遗忘）— 但非第 1 轮，不应重置 interval
    const after = replayLog(makeSnapshot(before), [
      {
        timestamp: 1,
        type: 'review' as const,
        childId: 'child_1',
        character: '花',
        grade: 'd' as const,
        round: 2,
        dayKey: '2026-06-28',
      },
    ])

    // SM-2 状态应保持不变
    const progress = after.children[0].progress['花']
    expect(progress.ease).toBe(2.5)
    expect(progress.interval).toBe(3)
    expect(progress.repetitions).toBe(2)
    expect(progress.nextReview).toBe('2026-06-30')
  })
})
