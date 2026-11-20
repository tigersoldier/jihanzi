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
import {
  generateTodayTasks,
  getChildStats,
  getEffectiveDayType,
  isDayComplete,
  resolveDayType,
} from './scheduler'
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
          nextCharIndex: 1, // ← 「一」已学，指针前进
          progress: {
            一: {
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
    expect(tasksAfter[1].character).toBe('三') // ← 跳过了二！
  })

  it('学新日：到期复习超过上限时仍固定学 dailyNewChars 个新字（两个配额独立）', () => {
    const learned = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛']
    const unlearned = ['壬', '癸']
    const progress: Record<string, SM2State> = {}
    for (const char of learned) {
      progress[char] = {
        ease: 2.5,
        interval: 1,
        repetitions: 1,
        nextReview: '2026-01-01', // 全部今天到期
        lastGrade: 'a',
        firstReviewDay: '2025-12-30',
      }
    }

    const state = makeState({
      children: [
        {
          id: 'child_1',
          name: '小明',
          wordBookId: 'wb_1',
          nextCharIndex: learned.length,
          progress,
        },
      ],
      wordBooks: [{ id: 'wb_1', name: '测试生字本', characters: [...learned, ...unlearned] }],
      settings: { dailyReviewLimit: 5, dailyNewChars: 2, maxRounds: 3 },
    })

    const tasks = generateTodayTasks(state, 'child_1', '2026-01-01', 'learn')

    // 复习被上限截断到 5 个，但新字配额不被挤占，仍然给满 2 个
    expect(tasks.filter(task => task.isReview)).toHaveLength(5)
    expect(tasks.filter(task => task.isNew).map(task => task.character)).toEqual(unlearned)
    expect(tasks).toHaveLength(7)
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
        花: { ease: 2.7, interval: 8, repetitions: 2, nextReview: '2026-07-08', lastGrade: 'a' },
        途: { ease: 2.5, interval: 1, repetitions: 0, nextReview: '2026-07-01', lastGrade: 'd' },
        滚: { ease: 2.56, interval: 20, repetitions: 3, nextReview: '2026-07-20', lastGrade: 'b' },
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
        斯: { ease: 2.38, interval: 6, repetitions: 3, nextReview: '2026-07-06', lastGrade: 'c' },
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
      一: { firstReviewDay: '2026-01-01' }, // ← 上次学习日引入了新字
    })
    expect(getEffectiveDayType('2026-01-01', progress)).toBe('review')
  })

  it('上次学习日无新字（纯复习日）→ 今日学新日', () => {
    // 2026-01-02 是纯复习日，没有引入新字（firstReviewDay 都不是 01-02）
    const progress = makeProgress({
      一: { firstReviewDay: '2026-01-01' }, // ← 新字是在 01-01 引入的，不是 01-02
    })
    expect(getEffectiveDayType('2026-01-02', progress)).toBe('learn')
  })

  it('跳天后日类型仍然正确翻转（上次学新日 → 今天复习日）', () => {
    // 用户在 01-01 学新字，01-02 缺席，01-03 回来
    const progress = makeProgress({
      一: { firstReviewDay: '2026-01-01' }, // ← 01-01 引入了新字
    })
    // 即使跳过了 01-02，也应该是复习日（因为上次学了新字）
    expect(getEffectiveDayType('2026-01-01', progress)).toBe('review')
  })

  it('连续两次学新日后 → 第三次为复习日', () => {
    // 模拟: 首日学新(learn) → 次日复习(无新字) → 第三日学新(有新字) → 第四日?
    const progress = makeProgress({
      一: { firstReviewDay: '2026-01-01' },
      二: { firstReviewDay: '2026-01-03' }, // ← 01-03 引入了新字
    })
    // lastStudyDay=01-03 有新字 → 今天应该是复习日
    expect(getEffectiveDayType('2026-01-03', progress)).toBe('review')
  })
})

describe('resolveDayType', () => {
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

  it('昨天学了新字 → 今天纯复习日（即使还有新字可学）', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2025-12-31' } })
    expect(
      resolveDayType({
        previousStudyDay: '2025-12-31',
        progress,
        hasUnlearnedChars: true,
        evaluatedDay: '2026-01-01',
      }),
    ).toBe('review')
  })

  it('昨天纯复习 + 有新字可学 → 今天学新日', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2025-12-30' } })
    expect(
      resolveDayType({
        previousStudyDay: '2025-12-31',
        progress,
        hasUnlearnedChars: true,
        evaluatedDay: '2026-01-01',
      }),
    ).toBe('learn')
  })

  it('昨天纯复习 + 没有新字可学 → 今天纯复习日', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2025-12-30' } })
    expect(
      resolveDayType({
        previousStudyDay: '2025-12-31',
        progress,
        hasUnlearnedChars: false,
        evaluatedDay: '2026-01-01',
      }),
    ).toBe('review')
  })

  it('昨天学了新字 + 生字本已学完 → 今天纯复习日', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2025-12-31' } })
    expect(
      resolveDayType({
        previousStudyDay: '2025-12-31',
        progress,
        hasUnlearnedChars: false,
        evaluatedDay: '2026-01-01',
      }),
    ).toBe('review')
  })

  it('契约守卫：把当天当成上一个学习日会直接报错', () => {
    expect(() =>
      resolveDayType({
        previousStudyDay: '2026-01-01',
        progress: {},
        hasUnlearnedChars: true,
        evaluatedDay: '2026-01-01',
      }),
    ).toThrow(/必须严格早于/)
  })

  it('从未学习但还有新字可学 → 今天学新日', () => {
    expect(
      resolveDayType({
        previousStudyDay: undefined,
        progress: {},
        hasUnlearnedChars: true,
        evaluatedDay: '2026-01-01',
      }),
    ).toBe('learn')
  })

  it('从未学习且没有新字可学 → 今天纯复习日', () => {
    expect(
      resolveDayType({
        previousStudyDay: undefined,
        progress: {},
        hasUnlearnedChars: false,
        evaluatedDay: '2026-01-01',
      }),
    ).toBe('review')
  })

  it('明日（上次学习日 = 今天）：今天学了新字 → 纯复习日', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2026-01-01' } })
    expect(
      resolveDayType({ previousStudyDay: '2026-01-01', progress, hasUnlearnedChars: true }),
    ).toBe('review')
  })

  it('明日（上次学习日 = 今天）：今天纯复习且有新字 → 学新日', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2025-12-30' } })
    expect(
      resolveDayType({ previousStudyDay: '2026-01-01', progress, hasUnlearnedChars: true }),
    ).toBe('learn')
  })

  it('明日：生字本已学完 → 纯复习日', () => {
    const progress = makeProgress({ 一: { firstReviewDay: '2025-12-30' } })
    expect(
      resolveDayType({ previousStudyDay: '2026-01-01', progress, hasUnlearnedChars: false }),
    ).toBe('review')
  })
})

describe('isDayComplete', () => {
  function state(entries: Record<string, Partial<SM2State>> = {}): Record<string, SM2State> {
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

  const base = { todayKey: '2026-01-01', dailyReviewLimit: 30 }

  it('今天展示的新字都已评过、没有到期字 → 完成', () => {
    expect(
      isDayComplete({
        ...base,
        progress: state({
          一: { firstReviewDay: '2026-01-01' },
          二: { firstReviewDay: '2026-01-01' },
        }),
        reviewedToday: ['一', '二'],
        presentedToday: ['一', '二'],
      }),
    ).toBe(true)
  })

  it('今天展示的新字还有没评的 → 未完成', () => {
    expect(
      isDayComplete({
        ...base,
        progress: state({ 一: { firstReviewDay: '2026-01-01' } }),
        reviewedToday: ['一'],
        presentedToday: ['一', '二'],
      }),
    ).toBe(false)
  })

  it('仍有到期旧字且没到每日上限 → 未完成', () => {
    expect(
      isDayComplete({
        ...base,
        progress: state({ 山: { firstReviewDay: '2025-12-31', nextReview: '2026-01-01' } }),
        reviewedToday: [],
        presentedToday: [],
      }),
    ).toBe(false)
  })

  it('到期旧字仍有、但今天的复习已达每日上限 → 完成（其余按调度结转次日）', () => {
    expect(
      isDayComplete({
        ...base,
        dailyReviewLimit: 1,
        progress: state({
          水: { firstReviewDay: '2025-12-31' },
          山: { firstReviewDay: '2025-12-31', nextReview: '2026-01-01' },
        }),
        reviewedToday: ['水'],
        presentedToday: [],
      }),
    ).toBe(true)
  })

  it('旧版本没有 present_chars：有今天的首轮评级即视为完成', () => {
    expect(
      isDayComplete({
        ...base,
        progress: state({ 一: { firstReviewDay: '2026-01-01' } }),
        reviewedToday: ['一'],
        presentedToday: [],
      }),
    ).toBe(true)
  })

  it('没有首轮评级 → 未完成', () => {
    expect(isDayComplete({ ...base, progress: {}, reviewedToday: [], presentedToday: [] })).toBe(
      false,
    )
  })
})
