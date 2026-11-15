import { useSyncExternalStore } from 'react'

/**
 * 「当天已完成」标记。
 *
 * 与种子（`useToday`）和月历（`ProgressPage`）共用同一份 localStorage 标记，
 * 并用模块级订阅让写入方（点「返回首页」、同步确认当天已有日志）能通知所有读取方
 * 重新渲染——否则月历要等到下次路由/状态变化才会显示今天。
 */

const DONE_KEY_PREFIX = 'jihanzi_done_'

const listeners = new Set<() => void>()

function doneKey(childId: string, dayKey: string): string {
  return `${DONE_KEY_PREFIX}${childId}_${dayKey}`
}

export function isDayDone(childId: string, dayKey: string): boolean {
  if (!childId) return false
  try {
    return localStorage.getItem(doneKey(childId, dayKey)) === '1'
  } catch {
    return false
  }
}

export function markDayDone(childId: string, dayKey: string): void {
  if (!childId) return
  try {
    localStorage.setItem(doneKey(childId, dayKey), '1')
  } catch {
    return
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 响应式读取「当天是否已完成」。 */
export function useDayDone(childId: string, dayKey: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => isDayDone(childId, dayKey),
    () => false,
  )
}
