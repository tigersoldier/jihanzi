/**
 * Test: verify that generateTodayTasks returns different task lists
 * before and after a review, demonstrating the mechanism behind the
 * skipping bug.
 *
 * When the state changes mid-session (nextCharIndex advances), the
 * task list shifts — characters that were at position N move to N-1,
 * so incrementing taskIndex by 1 effectively skips a character.
 */

import { describe, it, expect } from 'vitest'
import { generateTodayTasks, getChildStats, getEffectiveDayType } from './scheduler'
import type { AppState, Child, SM2State } from './types'

function makeState(overrides?: Partial<AppState>): AppState {
  return {
    children: [],
    wordBooks: [],
    settings: { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
    ...overrides,
  }
}

describe('generateTodayTasks', () => {
  it('state 更新后任务列表会发生变化（跳字 bug 的根本原因）', () => {
    // Given: 一个孩子、一个包含五个生字的生字本，尚未开始学习
    const beforeState = makeState({
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
          name: '测试生字本',
          characters: ['一', '二', '三', '四', '五'],
        },
      ],
    })

    // 学新日
    const learnDayKey = '2026-01-01'

    const tasksBefore = generateTodayTasks(beforeState, 'child_1', learnDayKey, 'learn')

    // 应该得到 5 个新字任务: 一、二、三、四、五
    expect(tasksBefore).toHaveLength(5)
    expect(tasksBefore[0].character).toBe('一')
    expect(tasksBefore[1].character).toBe('二')
    expect(tasksBefore[2].character).toBe('三')

    // When: 学完「一」后，state 更新——nextCharIndex 变为 1
    const afterState = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: 1,  // ← 「一」已学，指针前进
          progress: {
            '一': {
              ease: 2.6,
              interval: 1,
              repetitions: 1,
              nextReview: '2026-01-02',
              lastGrade: 'a',
            },
          },
        },
      ],
      wordBooks: [
        {
          id: 'wb_1',
          name: '测试生字本',
          characters: ['一', '二', '三', '四', '五'],
        },
      ],
    })

    const tasksAfter = generateTodayTasks(afterState, 'child_1', learnDayKey, 'learn')

    // 「一」已被学，不再出现在新字列表里
    // 新任务从「二」开始: 二、三、四、五
    expect(tasksAfter).toHaveLength(4)
    expect(tasksAfter[0].character).toBe('二')
    expect(tasksAfter[1].character).toBe('三')

    // Bug 演示：
    // tasksBefore[1] = 二, tasksBefore[2] = 三
    // tasksAfter[0]  = 二, tasksAfter[1]  = 三
    //
    // 在 session 中：如果 taskIndex 从 0 → 1 时，tasks 数组因 state
    // 更新而重新计算，那么 tasksAfter[taskIndex=1] = 三，而不是 二！
    // 用户就跳过了「二」。
    expect(tasksBefore[1].character).toBe('二')
    expect(tasksAfter[1].character).toBe('三')  // ← 跳过了二！
  })

  it('传入 dayType 参数时应优先生效', () => {
    const state = makeState({
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
          name: '测试生字本',
          characters: ['一', '二', '三'],
        },
      ],
    })

    const someDayKey = '2026-01-02'
    // 传入 dayType='learn' → 加入新字
    const tasksDefault = generateTodayTasks(state, 'child_1', someDayKey, 'learn')
    expect(tasksDefault.filter(t => t.isNew)).toHaveLength(3)

    // 传入 dayType='review' → 不加入新字
    const tasksReview = generateTodayTasks(state, 'child_1', someDayKey, 'review')
    expect(tasksReview.every(t => t.isNew === false)).toBe(true)
  })
})

describe('getChildStats', () => {
  it('按 ease 估算导致 grade d 被误算为 a', () => {
    // SM-2 resets ease to 2.5 on grade d.
    // Old ease-threshold: 2.5 >= 2.5 → "a" (mastered). Should be "d".
    const child: Child = {
      id: 'c1',
      name: 'test',
      wordBookId: 'wb1',
      nextCharIndex: 3,
      progress: {
        '花': { ease: 2.7, interval: 8, repetitions: 2, nextReview: '2026-07-08', lastGrade: 'a' },
        '途': { ease: 2.5, interval: 1, repetitions: 0, nextReview: '2026-07-01', lastGrade: 'd' },
        '滚': { ease: 2.56, interval: 20, repetitions: 3, nextReview: '2026-07-20', lastGrade: 'b' },
      },
    }

    const stats = getChildStats(child)

    // With lastGrade: 花=a, 途=d, 滚=b
    expect(stats.a).toBe(1)
    expect(stats.b).toBe(1)
    expect(stats.d).toBe(1)
  })

  it('按 ease 估算导致 grade c 被误算为 b', () => {
    // After grade 'c', ease≈2.38 → old heuristic: 2.0≤2.38<2.5 → "b".
    // Should be "c".
    const child: Child = {
      id: 'c1',
      name: 'test',
      wordBookId: 'wb1',
      nextCharIndex: 1,
      progress: {
        '斯': { ease: 2.38, interval: 6, repetitions: 3, nextReview: '2026-07-06', lastGrade: 'c' },
      },
    }

    const stats = getChildStats(child)
    expect(stats.c).toBe(1)
    expect(stats.b).toBe(0)
  })
})

describe('getEffectiveDayType', () => {
  function makeProgress(entries: Record<string, Partial<SM2State>> = {}): Record<string, SM2State> {
    const result: Record<string, SM2State> = {}
    for (const [char, partial] of Object.entries(entries)) {
      result[char] = {
        ease: 2.5,
        interval: 1,
        repetitions: 1,
        nextReview: '2026-01-02',
        lastGrade: 'a',
        firstReviewDay: '2026-01-01',
        ...partial,
      }
    }
    return result
  }

  it('从未学习过（无 lastStudyDay）→ 学新日', () => {
    expect(getEffectiveDayType(undefined, {})).toBe('learn')
  })

  it('上次学习日有新字 → 今日复习日', () => {
    const progress = makeProgress({
      '一': { firstReviewDay: '2026-01-01' },  // ← 上次学习日引入了新字
    })
    expect(getEffectiveDayType('2026-01-01', progress)).toBe('review')
  })

  it('上次学习日无新字（纯复习日）→ 今日学新日', () => {
    // 2026-01-02 是纯复习日，没有引入新字（firstReviewDay 都不是 01-02）
    const progress = makeProgress({
      '一': { firstReviewDay: '2026-01-01' },  // ← 新字是在 01-01 引入的，不是 01-02
    })
    expect(getEffectiveDayType('2026-01-02', progress)).toBe('learn')
  })

  it('跳天后日类型仍然正确翻转（上次学新日 → 今天复习日）', () => {
    // 用户在 01-01 学新字，01-02 缺席，01-03 回来
    const progress = makeProgress({
      '一': { firstReviewDay: '2026-01-01' },  // ← 01-01 引入了新字
    })
    // 即使跳过了 01-02，也应该是复习日（因为上次学了新字）
    expect(getEffectiveDayType('2026-01-01', progress)).toBe('review')
  })

  it('连续两次学新日后 → 第三次为复习日', () => {
    // 模拟: 首日学新(learn) → 次日复习(无新字) → 第三日学新(有新字) → 第四日?
    const progress = makeProgress({
      '一': { firstReviewDay: '2026-01-01' },
      '二': { firstReviewDay: '2026-01-03' },  // ← 01-03 引入了新字
    })
    // lastStudyDay=01-03 有新字 → 今天应该是复习日
    expect(getEffectiveDayType('2026-01-03', progress)).toBe('review')
  })
})
