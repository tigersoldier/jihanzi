/**
 * 导入文件解析。
 *
 * 从用户选择的文件（snapshot JSON / 日志 JSONL / 旧版整包备份）中
 * 识别出重放基座快照与日志条目。
 *
 * 目录导入可能同时包含多个快照（历史快照 + 当前快照 + 修复快照）。
 * 基座取「最近的一个固定日期快照」——名字为 snapshot_YYYY-MM-DD.json
 * 的历史快照中时间戳最新的一个：
 *   - 历史快照是应用在区间锚点归档的完整状态，之后的日志（如 07-11、
 *     07-21 区间文件）不在其中，必须在其上重放；
 *   - 不取最早：避免把过多已物化的日志重新重放、扩大不一致面；
 *   - 不用 snapshot_current.json：它可能被外部工具重写或与日志不一致，
 *     历史快照才是已知良好的重放起点。
 * 没有固定日期快照时（仅 snapshot_current / 旧版整包备份）回退到
 * 时间戳最新的一个。
 */

import type { AnyLogEntry, AppState, Settings } from '../core/types'
import { DEFAULT_SETTINGS } from '../core/types'

export interface ImportSnapshot {
  timestamp: number
  state: AppState
}

export interface ParsedImport {
  snapshot: ImportSnapshot | null
  logs: AnyLogEntry[]
}

/** 固定日期快照文件名：snapshot_YYYY-MM-DD.json（历史快照） */
const DATE_SNAPSHOT_RE = /^snapshot_\d{4}-\d{2}-\d{2}\.json$/

/**
 * 解析导入文件。文件按 { name, text } 传入，读取由调用方完成（便于测试）。
 */
export async function parseImportFiles(
  files: Array<{ name: string; text: string }>,
): Promise<ParsedImport> {
  // 固定日期快照（历史快照）：取时间戳最近的一个作为基座
  let dateSnapshot: ImportSnapshot | null = null
  // 其它快照（snapshot_current / snapshot_repaired / 旧版备份）：回退候选
  let otherSnapshot: ImportSnapshot | null = null
  const logs: AnyLogEntry[] = []

  for (const file of files) {
    const isJsonl = file.name.endsWith('.jsonl')

    if (isJsonl) {
      // JSONL — 每行一条日志
      file.text.split('\n').filter(l => l.trim()).forEach(line => {
        try {
          logs.push(JSON.parse(line))
        } catch { /* skip invalid lines */ }
      })
      continue
    }

    try {
      const parsed = JSON.parse(file.text)
      if (parsed.state && parsed.timestamp !== undefined) {
        if (DATE_SNAPSHOT_RE.test(file.name)) {
          if (!dateSnapshot || parsed.timestamp > dateSnapshot.timestamp) {
            dateSnapshot = parsed
          }
        } else if (!otherSnapshot || parsed.timestamp > otherSnapshot.timestamp) {
          otherSnapshot = parsed
        }
      } else if (Array.isArray(parsed)) {
        logs.push(...parsed)
      } else if (parsed.children || parsed.wordBooks) {
        // 旧版整包备份格式：children/wordBooks 即完整状态（非固定日期快照）
        const candidate: ImportSnapshot = {
          timestamp: Date.now(),
          state: {
            children: parsed.children || [],
            wordBooks: parsed.wordBooks || [],
            settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) } as Settings,
          },
        }
        if (!otherSnapshot || candidate.timestamp > otherSnapshot.timestamp) {
          otherSnapshot = candidate
        }
        if (parsed.logs) logs.push(...parsed.logs)
      }
    } catch { /* skip */ }
  }

  return { snapshot: dateSnapshot ?? otherSnapshot, logs }
}
