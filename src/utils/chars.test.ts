import { describe, it, expect } from 'vitest'
import { isChineseChar, validateAddChar, getPinyin, getCharInfo, getWords } from './chars'
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

describe('getCharInfo / getPinyin / getWords', () => {
  it('字典内汉字返回正确拼音和组词', () => {
    const info = getCharInfo('一')
    expect(info.pinyin).not.toBe('?')
    expect(info.pinyin).toBe('yī')
    expect(info.words.length).toBeGreaterThan(0)
  })

  it('字典外的常见汉字也返回有效拼音（非问号）', () => {
    // 这些字在原有硬编码字典中不存在，应该通过拼音库获取
    const chars = ['旅', '途', '伴', '随', '璃', '蜗', '蜘', '蛛']
    for (const char of chars) {
      const pinyin = getPinyin(char)
      expect(pinyin).not.toBe('?')
      expect(pinyin).toBeTruthy()
      // 单音字拼音只包含小写字母和声调符号
      expect(pinyin).toMatch(/^[a-zāáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜü]+$/)
    }
  })

  it('常见字的拼音符合预期', () => {
    expect(getPinyin('旅')).toBe('lǚ')
    expect(getPinyin('途')).toBe('tú')
    expect(getPinyin('伴')).toBe('bàn')
    expect(getPinyin('随')).toBe('suí')
  })

  it('getPinyin 是 getCharInfo 的快捷方式', () => {
    const char = '江'
    expect(getPinyin(char)).toBe(getCharInfo(char).pinyin)
  })

  it('getWords 是 getCharInfo 的快捷方式', () => {
    const char = '海'
    expect(getWords(char)).toBe(getCharInfo(char).words)
  })

  it('未知字符的 words 返回空数组', () => {
    // 对于字典中没有组词数据的字，words 可以为空但不影响拼音
    const info = getCharInfo('蛛')
    expect(info.pinyin).not.toBe('?')
    expect(Array.isArray(info.words)).toBe(true)
  })

  it('多音字返回全部读音，用 · 分隔', () => {
    expect(getPinyin('长')).toBe('cháng · zhǎng')
    expect(getPinyin('行')).toContain('xíng')
    expect(getPinyin('行')).toContain('háng')
    // pinyin-pro 返回全部读音（含生僻音），覆盖面完整
    expect(getPinyin('乐')).toContain('lè')
    expect(getPinyin('乐')).toContain('yuè')
    expect(getPinyin('重')).toBe('zhòng · chóng')
  })

  it('多音字的全部读音也是有效拼音格式', () => {
    // 分隔符是 " · "（空格+圆点+空格）
    const pinyin = getPinyin('长')
    const parts = pinyin.split(' · ')
    expect(parts.length).toBeGreaterThan(1)
    for (const part of parts) {
      expect(part).toMatch(/^[a-zāáǎàōóǒòēéěèīíǐìūúǔùǖǘǚǜü]+$/)
    }
  })
})
