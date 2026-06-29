import { describe, it, expect } from 'vitest'
import { isChineseChar, validateAddChar } from './chars'
import type { WordBook } from '../core/types'

describe('isChineseChar', () => {
  it('BMP 基本区的汉字返回 true', () => {
    expect(isChineseChar('花')).toBe(true)
    expect(isChineseChar('字')).toBe(true)
    expect(isChineseChar('漢')).toBe(true)
  })

  it('CJK Extension A 的汉字返回 true', () => {
    // U+3400 (㐀) — CJK Extension A start
    expect(isChineseChar('㐀')).toBe(true)
    // U+4DBF (䶿) — CJK Extension A end
    expect(isChineseChar('䶿')).toBe(true)
  })

  it('CJK Extension B (补充平面) 的汉字返回 true', () => {
    // U+20000 (𠀀) — CJK Extension B, supplementary plane
    expect(isChineseChar('\u{20000}')).toBe(true)
  })

  it('英文字母返回 false', () => {
    expect(isChineseChar('a')).toBe(false)
    expect(isChineseChar('Z')).toBe(false)
  })

  it('数字返回 false', () => {
    expect(isChineseChar('1')).toBe(false)
    expect(isChineseChar('0')).toBe(false)
  })

  it('标点符号返回 false', () => {
    expect(isChineseChar('@')).toBe(false)
    expect(isChineseChar('。')).toBe(false)
    expect(isChineseChar('、')).toBe(false)
  })

  it('emoji 返回 false', () => {
    expect(isChineseChar('🌸')).toBe(false)
  })

  it('日文假名返回 false', () => {
    expect(isChineseChar('あ')).toBe(false)  // hiragana
    expect(isChineseChar('ア')).toBe(false)  // katakana
  })

  it('韩文谚文返回 false', () => {
    expect(isChineseChar('안')).toBe(false)
  })

  it('空字符串返回 false', () => {
    expect(isChineseChar('')).toBe(false)
  })
})

describe('validateAddChar', () => {
  const wb: WordBook = {
    id: 'wb_1',
    name: '测试字本',
    characters: ['花', '一', '二', '三'],
  }

  it('生字本中不存在的汉字 → 不抛错', () => {
    expect(() => validateAddChar('大', wb)).not.toThrow()
  })

  it('生字本中已存在的汉字 → 抛出错误', () => {
    expect(() => validateAddChar('花', wb)).toThrow('已在生字本中')
  })

  it('非汉字字符 → 抛出错误', () => {
    expect(() => validateAddChar('a', wb)).toThrow('不是汉字')
    expect(() => validateAddChar('1', wb)).toThrow('不是汉字')
    expect(() => validateAddChar('🌸', wb)).toThrow('不是汉字')
  })
})
