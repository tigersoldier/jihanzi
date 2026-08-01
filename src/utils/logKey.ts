/**
 * 日志去重键工具函数。
 *
 * 从 sync.ts 中提取，供 drive.ts (pushLogs 去重) 和 sync.ts (diffEntries) 共享，
 * 避免循环依赖。
 */

import type { AnyLogEntry } from '../core/types'

/**
 * 构建日志去重键。
 * review 条目使用 timestamp + childId + character 作为自然主键；
 * present_chars 使用 timestamp + childId + dayKey；
 * 其它条目沿用 timestamp + type + entityId 三元组。
 */
export function makeDiffKey(e: AnyLogEntry): string {
  if (e.type === 'review') {
    return `${e.timestamp}:${e.type}:${e.childId}:${e.character}`
  }
  if (e.type === 'present_chars') {
    return `${e.timestamp}:${e.type}:${e.childId}:${e.dayKey}`
  }
  // 泛用键：timestamp + type + 实体 ID
  const entityId = 'childId' in e ? e.childId : 'wordBookId' in e ? e.wordBookId : ''
  return `${e.timestamp}:${e.type}:${entityId}`
}

/**
 * 按 makeDiffKey 稳定去重，保留每个键首次出现的条目。
 *
 * 日志条目不可变，相同键即相同事件（如同步重复追加产生的副本）。
 * 去重是同步合并、快照重放和日志修复的前置步骤——重复条目若被
 * 多次应用到 SM-2 状态会导致间隔指数爆炸（同一复习被应用 N 次，
 * interval 每次乘以 ease）。
 */
export function dedupeLogEntries(entries: AnyLogEntry[]): AnyLogEntry[] {
  const seen = new Set<string>()
  const result: AnyLogEntry[] = []
  for (const entry of entries) {
    const key = makeDiffKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(entry)
  }
  return result
}
