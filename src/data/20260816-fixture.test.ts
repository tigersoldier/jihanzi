/**
 * @vitest-environment node
 *
 * 20260816 真实事故数据回归夹具。
 *
 * 数据来源：用户导出的同步事故现场（2026-08-16）——快照被同一复习
 * 重复应用约 3 次（interval 指数放大至 36500 封顶、nextReview 推到
 * 2085/2126 年），日志文件已由历史修复去重干净。
 *
 * 修复目标（对应 ADR 0007）：
 * - repairSnapshotProgress 逐字修复：历史完整且与守卫重放不一致的字
 *   用重放值替换（130 个字）；
 * - salvageUnverifiableHeavy 8a 兜底：29 个历史不完整且 interval ≥ 10 年
 *   的字重置 interval=1，靠真实复习自然重建；
 * - 历史不完整且未达兜底阈值的字保持原样（不误伤）。
 *
 * 若上游数据有变（如导出目录更新），用 docs 记录的方式重新生成夹具：
 *   cp <导出目录>/snapshot_current.json src/data/__fixtures__/20260816/snapshot.json
 *   cat <导出目录>/log_*.jsonl > src/data/__fixtures__/20260816/logs.jsonl
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { repairSnapshotProgress, salvageUnverifiableHeavy, verifySnapshotAgainstLogs } from './sync'
import type { AnyLogEntry, Snapshot } from '../core/types'

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', '20260816')

function loadFixture(): { snapshot: Snapshot; logs: AnyLogEntry[] } {
  const snapshot = JSON.parse(readFileSync(join(FIXTURE_DIR, 'snapshot.json'), 'utf-8')) as Snapshot
  const logs = readFileSync(join(FIXTURE_DIR, 'logs.jsonl'), 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l) as AnyLogEntry)
  return { snapshot, logs }
}

describe('20260816 真实事故数据回归', () => {
  const { snapshot, logs } = loadFixture()

  it('verifySnapshotAgainstLogs 检出快照污染（135 个可验证字不一致）', () => {
    const verification = verifySnapshotAgainstLogs(snapshot.state, logs)
    expect(verification.polluted).toBe(true)
    expect(verification.mismatches).toHaveLength(135)
  })

  it('关键污染字被逐字修复为守卫重放值', () => {
    const { state } = repairSnapshotProgress(snapshot.state, logs)
    const progress = state.children[0].progress

    // ×3 污染（同一复习被应用 3 次）
    expect(progress['今']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-12',
      firstReviewDay: '2026-05-18',
    })
    // interval 封顶 36500 + 05-19 机械重复被防护跳过
    expect(progress['住']).toMatchObject({
      ease: 2.56,
      interval: 20,
      repetitions: 3,
      nextReview: '2026-07-19',
      lastGrade: 'b',
    })
    // 缺失应用：08-04 的 d 从未被应用 → 补回重置
    expect(progress['及']).toMatchObject({
      ease: 2.5,
      interval: 1,
      repetitions: 0,
      nextReview: '2026-08-05',
      lastGrade: 'd',
      firstReviewDay: '2026-05-28',
    })
    // 双设备重复学习新字（08-04/08-05 两次 round-1）→ 只计一次
    expect(progress['弯']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-08-21',
      firstReviewDay: '2026-08-04',
    })
    expect(progress['察']).toMatchObject({
      ease: 2.46,
      interval: 5,
      repetitions: 2,
      nextReview: '2026-08-13',
      firstReviewDay: '2026-08-04',
    })
    // 24 小时机械重复对（03-03/03-04）→ 只计一条
    expect(progress['贯']).toMatchObject({
      ease: 2.46,
      interval: 7,
      repetitions: 2,
      nextReview: '2026-07-06',
      lastGrade: 'b',
      firstReviewDay: '2026-03-03',
    })
    expect(progress['报']).toMatchObject({
      ease: 2.7,
      interval: 8,
      repetitions: 2,
      nextReview: '2026-06-03',
    })
  })

  it('修复范围与事故规模一致（恰好 135 个字）', () => {
    const { repaired } = repairSnapshotProgress(snapshot.state, logs)
    const expected =
      '今仪住作供充兰列前升即压原及可各合同向吱品嘎圆坡培塔壁处夏孤宽察尽岭峰左席幕并底度建弯忙怀感所扣报拧持换捷提插搭支斜斯晨普曼曾服末枝柳栈栓梦棉椅模此沉沸洞深热焖狂留登皂盯眠砂示立簸籍线组经给续维缓群聊肘肥胳腹般艰色艾芒英茄茶补角讯该贩贯迈迎选速邮部重野针链闪降限陡霍颠香'
    expect([...repaired].sort().join('')).toBe(expected)
  })

  it('修复后的字 interval 全部 ≤ 30 天（无重复应用残留）', () => {
    const { state, repaired } = repairSnapshotProgress(snapshot.state, logs)
    const progress = state.children[0].progress
    for (const ch of repaired) {
      expect(progress[ch].interval).toBeLessThanOrEqual(30)
      expect(progress[ch].nextReview <= '2027-01-01').toBe(true)
    }
  })

  it('8a 兜底：29 个重污染且不可验证的字被重置 interval=1', () => {
    const { state: repaired } = repairSnapshotProgress(snapshot.state, logs)
    const salvaged = salvageUnverifiableHeavy(repaired, logs)
    const expected = '伴位便修刹刻厢响将岸州巨律息恰拂敏格汗牌特直而脚节观路连途'
    expect([...salvaged].sort().join('')).toBe(expected)
    for (const ch of salvaged) {
      expect(repaired.children[0].progress[ch]).toMatchObject({ ease: 2.5, interval: 1 })
      expect(repaired.children[0].progress[ch].nextReview).not.toBe('NaN-NaN-NaN')
    }
  })

  it('已干净的字（鼓/谷/舒）与不完整且未达阈值的字保持原样', () => {
    const { state, repaired } = repairSnapshotProgress(snapshot.state, logs)
    const progress = state.children[0].progress
    // 未被修复：快照原值不变
    for (const ch of ['鼓', '谷', '舒']) {
      expect(repaired).not.toContain(ch)
    }
    expect(progress['鼓']).toMatchObject({
      ease: 2.32,
      interval: 16,
      repetitions: 3,
      nextReview: '2026-08-31',
    })
    // 不完整历史且 interval < 10 年：不参与核对也不兑底，原值保留
    const fu = snapshot.state.children[0].progress['伏']
    expect(progress['伏']).toEqual(fu)
    expect(repaired).not.toContain('伏')
  })

  it('修复管道纯函数：输入快照不被修改', () => {
    const before = JSON.stringify(snapshot.state)
    repairSnapshotProgress(snapshot.state, logs)
    expect(JSON.stringify(snapshot.state)).toBe(before)
  })
})
