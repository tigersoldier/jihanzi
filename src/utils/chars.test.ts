import { describe, it, expect } from 'vitest'
import { isChineseChar, validateAddChar, getPinyin, getCharInfo, getWords } from './chars'
import { COMMON_WORDS } from './commonWords'
import SUBTLEX_WORD_EXAMPLES from './subtlexWordExamples.json'
import MTEH_WORD_EXAMPLES from './mtehWordExamples.json'
import UNSUITABLE_WORD_EXAMPLE_TERMS from '../../scripts/word-example-safety-terms.json'
import type { WordBook } from '../core/types'

const SAFE_WORD_EXAMPLE_EXCEPTIONS = new Set(['高潮迭起', '放荡不羁', '杀手锏'])

const isUnsuitableWordExample = (word: string): boolean =>
  !SAFE_WORD_EXAMPLE_EXCEPTIONS.has(word) &&
  UNSUITABLE_WORD_EXAMPLE_TERMS.some(term => word.includes(term))

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
    expect(isChineseChar('あ')).toBe(false) // hiragana
    expect(isChineseChar('ア')).toBe(false) // katakana
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
    // 拼音由拼音库生成，与该字是否有组词数据无关
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

  it('离线词表提供广泛覆盖且只索引短汉字词', () => {
    const characters = new Set(COMMON_WORDS.flatMap(word => [...word]))

    expect(COMMON_WORDS.length).toBeGreaterThan(1000)
    expect(characters.size).toBeGreaterThan(800)
    expect(
      COMMON_WORDS.every(word => {
        const length = [...word].length
        return length >= 2 && length <= 4 && /^\p{Script=Han}+$/u.test(word)
      }),
    ).toBe(true)
    expect(
      [...characters].every(character => {
        const words = getWords(character)
        return (
          words.length > 0 &&
          words.length <= 3 &&
          new Set(words).size === words.length &&
          words.every(word => word.includes(character))
        )
      }),
    ).toBe(true)
  })

  it('SUBTLEX-CH 高频索引覆盖数千个汉字', () => {
    const entries = Object.entries(SUBTLEX_WORD_EXAMPLES)

    expect(entries.length).toBeGreaterThan(3500)
    expect(
      entries.every(([character, words]) => {
        return (
          [...character].length === 1 &&
          words.length > 0 &&
          words.length <= 3 &&
          words.every(word => word.includes(character) && /^\p{Script=Han}{2,4}$/u.test(word))
        )
      }),
    ).toBe(true)
    expect(getWords('亡')).toContain('死亡')
  })

  it('不适龄词例不会进入离线索引或复习卡片', () => {
    const indexedWords = [
      ...Object.values(SUBTLEX_WORD_EXAMPLES).flat(),
      ...Object.values(MTEH_WORD_EXAMPLES).flat(),
      ...COMMON_WORDS,
    ]
    const characters = new Set([
      ...Object.keys(SUBTLEX_WORD_EXAMPLES),
      ...Object.keys(MTEH_WORD_EXAMPLES),
      ...COMMON_WORDS.flatMap(word => [...word]),
    ])

    expect(indexedWords.every(word => !isUnsuitableWordExample(word))).toBe(true)
    expect([...characters].flatMap(getWords).every(word => !isUnsuitableWordExample(word))).toBe(
      true,
    )
    expect(isUnsuitableWordExample('高潮')).toBe(true)
    expect(isUnsuitableWordExample('高潮迭起')).toBe(false)
    expect(isUnsuitableWordExample('放荡')).toBe(true)
    expect(isUnsuitableWordExample('放荡不羁')).toBe(false)
    expect(isUnsuitableWordExample('杀手')).toBe(true)
    expect(isUnsuitableWordExample('杀手锏')).toBe(false)
    expect(getWords('他')).not.toContain('他妈的')
    expect(getWords('妇')).not.toContain('荡妇')
    expect(getWords('妇')).toContain('妇女')
    expect(getWords('性')).not.toContain('性感')
    expect(getWords('性')).toContain('同性恋')
    expect(getWords('尤')).not.toContain('尤物')
    expect(getWords('艳')).not.toContain('艳福')
    expect(getWords('潮')).not.toContain('高潮')
    expect(getWords('迭')).toContain('高潮迭起')
    expect(getWords('荡')).not.toContain('放荡')
    expect(getWords('羁')).toContain('放荡不羁')
    expect(getWords('血')).toContain('血迹')
    expect(getWords('暴')).toContain('暴力')
    expect(getWords('架')).toContain('打架')
    expect(getWords('笨')).toContain('笨蛋')
    expect(getWords('傻')).toContain('傻瓜')
    expect(getWords('爆')).toContain('爆炸')
    expect(getWords('窥')).toContain('偷窥')
    expect(getWords('妩')).toContain('妩媚')
    expect(getWords('娆')).toContain('妖娆妩媚')
    expect(getWords('刎')).toContain('刎颈之交')
    expect(getWords('奸').every(word => !isUnsuitableWordExample(word))).toBe(true)
    expect(getWords('锏')).toContain('杀手锏')

    const newlyFilteredWords = [
      '傻子',
      '蠢货',
      '杀害',
      '杀死',
      '杀一儆百',
      '暗杀',
      '凶手',
      '击毙',
      '炸弹',
      '纵火',
      '厮杀',
      '袭击',
      '绑架',
      '绑匪',
      '劫持',
      '枪击',
      '狙击',
      '殴打',
      '鞭打',
      '鞭挞',
      '鞭挞船员',
      '拷问',
      '虐待',
      '死尸',
      '血雨腥风',
      '遍体鳞伤',
    ]
    for (const word of newlyFilteredWords) {
      expect(isUnsuitableWordExample(word)).toBe(true)
      for (const character of word) expect(getWords(character)).not.toContain(word)
    }
  })

  it('MteH 提示索引为 SUBTLEX 未覆盖的汉字补充例词', () => {
    const entries = Object.entries(MTEH_WORD_EXAMPLES)

    expect(entries.length).toBeGreaterThan(700)
    expect(
      entries.every(([character, words]) => {
        return (
          !SUBTLEX_WORD_EXAMPLES[character as keyof typeof SUBTLEX_WORD_EXAMPLES] &&
          [...character].length === 1 &&
          words.length === 1 &&
          words[0].includes(character) &&
          /^\p{Script=Han}{2,4}$/u.test(words[0]) &&
          !isUnsuitableWordExample(words[0])
        )
      }),
    ).toBe(true)
    expect(getWords('丞')).toContain('东吴丞相')
    expect(getWords('丞').length).toBeLessThanOrEqual(3)
  })

  it('常用词表为原先缺少组词的汉字补充例词', () => {
    const expectedWords: Record<string, string> = {
      旅: '旅途',
      途: '旅途',
      伴: '伙伴',
      随: '随时',
      璃: '玻璃',
      蜗: '蜗牛',
      蜘: '蜘蛛',
      蛛: '蜘蛛',
    }

    for (const [character, word] of Object.entries(expectedWords)) {
      const words = getWords(character)
      expect(words).toContain(word)
      expect(words.length).toBeLessThanOrEqual(3)
      expect(new Set(words).size).toBe(words.length)
      expect(words.every(example => example.includes(character))).toBe(true)
    }
  })

  it('词表未覆盖的汉字仍可没有组词', () => {
    const info = getCharInfo('鼍')
    expect(info.pinyin).not.toBe('?')
    expect(info.words).toEqual([])
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
