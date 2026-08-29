import { describe, it, expect } from 'vitest'
import { parseHash, routeToHash } from './router'

describe('parseHash', () => {
  it('空 hash → 默认页（学习进度）', () => {
    expect(parseHash('')).toEqual({ name: 'progress' })
    expect(parseHash('#')).toEqual({ name: 'progress' })
  })

  it('基础标签页', () => {
    expect(parseHash('#/progress')).toEqual({ name: 'progress' })
    expect(parseHash('#/child')).toEqual({ name: 'child' })
    expect(parseHash('#/wordbook')).toEqual({ name: 'wordbook' })
    expect(parseHash('#/settings')).toEqual({ name: 'settings' })
  })

  it('带月份 / 日期 / 生字的学习进度', () => {
    expect(parseHash('#/progress/2026-08')).toEqual({ name: 'progress', month: '2026-08' })
    expect(parseHash('#/progress/2026-08/2026-08-16')).toEqual({
      name: 'progress',
      month: '2026-08',
      day: '2026-08-16',
    })
    expect(parseHash('#/progress/2026-08/2026-08-16/花')).toEqual({
      name: 'progress',
      month: '2026-08',
      day: '2026-08-16',
      char: '花',
    })
  })

  it('百分号编码的汉字正常解码', () => {
    expect(parseHash('#/progress/2026-08/2026-08-16/%E9%9B%A8')).toEqual({
      name: 'progress',
      month: '2026-08',
      day: '2026-08-16',
      char: '雨',
    })
    expect(parseHash('#/wordbook/char/%E9%9B%A8')).toEqual({ name: 'wordbook', char: '雨' })
  })

  it('非法月份 / 日期 → 回退到可解析的最浅层级', () => {
    // 非法月份 → 默认页
    expect(parseHash('#/progress/2026-13')).toEqual({ name: 'progress' })
    expect(parseHash('#/progress/abc')).toEqual({ name: 'progress' })
    // 非法日期 → 月份视图
    expect(parseHash('#/progress/2026-08/foo')).toEqual({ name: 'progress', month: '2026-08' })
    // 日期与月份不一致 → 月份视图
    expect(parseHash('#/progress/2026-08/2026-07-01')).toEqual({
      name: 'progress',
      month: '2026-08',
    })
  })

  it('生字本：选中字本 / 查看生字', () => {
    expect(parseHash('#/wordbook/wb/wb_1754000000000')).toEqual({
      name: 'wordbook',
      wbId: 'wb_1754000000000',
    })
    expect(parseHash('#/wordbook/char/花')).toEqual({ name: 'wordbook', char: '花' })
  })

  it('非法百分号编码不抛错，按原样返回', () => {
    expect(parseHash('#/wordbook/char/%E4%B8')).toEqual({ name: 'wordbook', char: '%E4%B8' })
  })

  it('未知路由 → 回退到默认页', () => {
    expect(parseHash('#/foo')).toEqual({ name: 'progress' })
    expect(parseHash('#/progress/x/y/z')).toEqual({ name: 'progress' })
  })
})

describe('routeToHash', () => {
  it('基础路由', () => {
    expect(routeToHash({ name: 'progress' })).toBe('#/progress')
    expect(routeToHash({ name: 'child' })).toBe('#/child')
    expect(routeToHash({ name: 'wordbook' })).toBe('#/wordbook')
    expect(routeToHash({ name: 'settings' })).toBe('#/settings')
  })

  it('学习进度子状态：无月份时不带多余段', () => {
    expect(routeToHash({ name: 'progress', month: '2026-08' })).toBe('#/progress/2026-08')
    expect(routeToHash({ name: 'progress', month: '2026-08', day: '2026-08-16' })).toBe(
      '#/progress/2026-08/2026-08-16',
    )
    expect(routeToHash({ name: 'progress', month: '2026-08', day: '2026-08-16', char: '花' })).toBe(
      '#/progress/2026-08/2026-08-16/%E8%8A%B1',
    )
  })

  it('生字本：char 优先于 wbId，汉字百分号编码', () => {
    expect(routeToHash({ name: 'wordbook', wbId: 'wb_1' })).toBe('#/wordbook/wb/wb_1')
    expect(routeToHash({ name: 'wordbook', char: '雨' })).toBe('#/wordbook/char/%E9%9B%A8')
  })

  it('与 parseHash 互逆', () => {
    const routes = [
      { name: 'progress' },
      { name: 'progress', month: '2026-08' },
      { name: 'progress', month: '2026-08', day: '2026-08-16' },
      { name: 'progress', month: '2026-08', day: '2026-08-16', char: '花' },
      { name: 'child' },
      { name: 'wordbook' },
      { name: 'wordbook', wbId: 'wb_1' },
      { name: 'wordbook', char: '雨' },
      { name: 'settings' },
    ]
    for (const r of routes) {
      expect(parseHash(routeToHash(r as never))).toEqual(r)
    }
  })
})
