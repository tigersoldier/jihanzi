import { describe, expect, it } from 'vitest'
import { isLearningKaiGlyphSupported } from './learningFontCoverage'

describe('isLearningKaiGlyphSupported', () => {
  it('recognizes common simplified Chinese characters included in the embedded font', () => {
    expect(isLearningKaiGlyphSupported('学')).toBe(true)
    expect(isLearningKaiGlyphSupported('国')).toBe(true)
    expect(isLearningKaiGlyphSupported('永')).toBe(true)
  })

  it('retains the embedded font cmap coverage', () => {
    let supportedGlyphs = 0
    for (let codePoint = 0x4e00; codePoint <= 0x9fff; codePoint += 1) {
      if (isLearningKaiGlyphSupported(String.fromCodePoint(codePoint))) supportedGlyphs += 1
    }
    expect(supportedGlyphs).toBe(18429)
  })

  it('rejects characters missing from the font instead of allowing system fallback', () => {
    expect(isLearningKaiGlyphSupported('乊')).toBe(false)
    expect(isLearningKaiGlyphSupported('𠀀')).toBe(false)
    expect(isLearningKaiGlyphSupported('汉字')).toBe(false)
    expect(isLearningKaiGlyphSupported('')).toBe(false)
  })
})
