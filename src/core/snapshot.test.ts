import { describe, it, expect } from 'vitest'
import { compactLogs, rebuildState } from './snapshot'
import { replayLog } from './log'
import type { AppState, Snapshot, AnyLogEntry } from './types'

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

describe('compactLogs', () => {
  it('压缩后的快照与完整日志重放产生相同状态', () => {
    // Given: a snapshot with one child, and several log entries after it
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

    const logs: AnyLogEntry[] = [
      {
        timestamp: 1,
        type: 'review',
        childId: 'child_1',
        character: '花',
        grade: 'a',
        round: 1,
        dayKey: '2026-06-28',
      },
      {
        timestamp: 2,
        type: 'review',
        childId: 'child_1',
        character: '一',
        grade: 'b',
        round: 1,
        dayKey: '2026-06-29',
      },
    ]

    // When: compacting
    const { snapshot: compacted } = compactLogs(makeSnapshot(before), logs)

    // Then: replaying just the new snapshot gives the same state
    // as replaying old snapshot + all logs
    const fromCompacted = replayLog(compacted, [])
    const fromOriginal = replayLog(makeSnapshot(before), logs)

    expect(fromCompacted).toEqual(fromOriginal)
    // Verify the reviews were applied correctly
    const child = fromCompacted.children[0]
    expect(child.progress['花']).toBeDefined()
    expect(child.progress['一']).toBeDefined()
    // 「二」 hasn't been reviewed yet
    expect(child.progress['二']).toBeUndefined()
  })

  it('压缩后返回的日志列表为空——所有日志已被快照覆盖', () => {
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
        { id: 'wb_1', name: '测试生字本', characters: ['花'] },
      ],
    })

    const logs: AnyLogEntry[] = Array.from({ length: 100 }, (_, i) => ({
      timestamp: i + 1,
      type: 'review' as const,
      childId: 'child_1',
      character: '花',
      grade: 'a' as const,
      round: 1,
      dayKey: '2026-06-28',
    }))

    const { logs: remaining } = compactLogs(makeSnapshot(before), logs)

    // After compaction, no logs remain — they're all covered by the snapshot
    expect(remaining).toHaveLength(0)
  })

  it('resbuildState 与直接调用 replayLog 结果一致', () => {
    const state = makeState()
    const logs: AnyLogEntry[] = [
      {
        timestamp: 1,
        type: 'create_child' as const,
        childId: 'child_x',
        name: '大明',
        wordBookId: 'wb_x',
      },
      {
        timestamp: 2,
        type: 'create_wordbook' as const,
        wordBookId: 'wb_x',
        name: '自定义生字本',
        characters: ['天', '地'],
      },
    ]

    const fromRebuild = rebuildState(null, logs)
    const fromReplay = replayLog(null, logs)

    expect(fromRebuild).toEqual(fromReplay)
    expect(fromRebuild.children).toHaveLength(1)
    expect(fromRebuild.children[0].name).toBe('大明')
    expect(fromRebuild.wordBooks).toHaveLength(1)
    expect(fromRebuild.wordBooks[0].name).toBe('自定义生字本')
  })
})
