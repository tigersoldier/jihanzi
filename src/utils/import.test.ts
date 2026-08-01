/**
 * parseImportFiles 测试 — 导入文件解析。
 *
 * 目录导入可能同时包含多个快照（历史快照 + 当前快照 + 修复快照）。
 * 重放基座必须是「最近的一个固定日期快照」：
 * 历史快照（snapshot_YYYY-MM-DD.json）是应用在区间锚点归档的完整状态，
 * 之后的日志（如 07-11、07-21）不在其中，需要在其上重放；
 * 不取最早（避免重放过多日志）、不用 snapshot_current（可能被外部
 * 工具重写或与日志不一致）。
 */

import { describe, it, expect } from 'vitest'
import { parseImportFiles } from './import'

function snapshotFile(name: string, timestamp: number) {
  return { name, text: JSON.stringify({ timestamp, state: { children: [], wordBooks: [], settings: {} } }) }
}

describe('parseImportFiles — 导入文件解析', () => {
  it('多个快照时取最近的一个固定日期快照（不取最早、不用 snapshot_current）', async () => {
    const files = [
      snapshotFile('snapshot_2026-06-21.json', 1782000000000), // 最早的固定日期快照
      snapshotFile('snapshot_2026-07-01.json', 1783663380979), // 固定日期快照中最近的一个（07-09 23:03）
      snapshotFile('snapshot_current.json', 1785564867246),    // 时间戳最新但不是固定日期快照
    ]
    // 文件顺序无关
    const { snapshot } = await parseImportFiles([files[2], files[1], files[0]])
    expect(snapshot?.timestamp).toBe(1783663380979)
  })

  it('没有固定日期快照时回退到 snapshot_current', async () => {
    const { snapshot } = await parseImportFiles([
      snapshotFile('snapshot_current.json', 1785564867246),
    ])
    expect(snapshot?.timestamp).toBe(1785564867246)
  })

  it('解析 jsonl 日志文件，跳过无效行', async () => {
    const { snapshot, logs } = await parseImportFiles([
      { name: 'log_2026-07-21.jsonl', text: [
        JSON.stringify({ timestamp: 1, type: 'review', childId: 'c', character: '一', grade: 'a', round: 1, dayKey: '2026-07-21' }),
        'not-json',
        '',
        JSON.stringify({ timestamp: 2, type: 'review', childId: 'c', character: '二', grade: 'b', round: 1, dayKey: '2026-07-21' }),
      ].join('\n') },
    ])
    expect(snapshot).toBeNull()
    expect(logs).toHaveLength(2)
    expect(logs[0].character).toBe('一')
    expect(logs[1].character).toBe('二')
  })

  it('解析旧版整包备份格式（children/wordBooks + logs）', async () => {
    const { snapshot, logs } = await parseImportFiles([
      { name: 'backup.json', text: JSON.stringify({
        children: [{ id: 'c1', name: '小明' }],
        wordBooks: [],
        logs: [{ timestamp: 100, type: 'review', childId: 'c1', character: '一', grade: 'a', round: 1, dayKey: '2026-07-01' }],
      }) },
    ])
    expect(snapshot).not.toBeNull()
    expect(snapshot!.state.children[0].name).toBe('小明')
    expect(logs).toHaveLength(1)
  })

  it('同时导入旧版备份与真实快照时，固定日期快照胜出', async () => {
    const realSnapshot = {
      timestamp: 1783663380979,
      state: { children: [], wordBooks: [], settings: {} },
    }
    const { snapshot } = await parseImportFiles([
      { name: 'backup.json', text: JSON.stringify({ children: [], wordBooks: [], logs: [] }) },
      { name: 'snapshot_2026-07-01.json', text: JSON.stringify(realSnapshot) },
    ])
    expect(snapshot?.timestamp).toBe(1783663380979)
  })
})
