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
  const entityId = (e as any).childId || (e as any).wordBookId || ''
  return `${e.timestamp}:${e.type}:${entityId}`
}
