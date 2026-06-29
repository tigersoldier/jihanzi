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
import { generateTodayTasks } from './scheduler'
import type { AppState } from './types'

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

    // 学习日: 2026-01-01 是 EPOCH_LEARN_DATE
    const learnDayKey = '2026-01-01'

    const tasksBefore = generateTodayTasks(beforeState, 'child_1', learnDayKey)

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

    const tasksAfter = generateTodayTasks(afterState, 'child_1', learnDayKey)

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
})
