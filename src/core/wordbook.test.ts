import { describe, expect, it } from 'vitest'
import type { SM2State } from './types'
import { filterCharactersByProficiency, sortWordBookCharacters } from './wordbook'

function state(overrides: Partial<SM2State> = {}): SM2State {
  return {
    ease: 2.5,
    interval: 1,
    repetitions: 1,
    nextReview: '2026-06-10',
    lastGrade: 'b',
    firstReviewDay: '2026-06-01',
    ...overrides,
  }
}

const progress: Record<string, SM2State> = {
  花: state({ repetitions: 3, lastGrade: 'a', nextReview: '2026-06-08' }),
  山: state({ repetitions: 0, lastGrade: 'd', nextReview: '2026-06-02' }),
  水: state({ repetitions: 1, lastGrade: 'b', nextReview: '2026-06-05' }),
}

describe('word book sorting and filtering', () => {
  it('sorts learned characters by total review count, keeping ties stable and unlearned last', () => {
    const characters = ['水', '花', '雨', '山']
    const sorted = sortWordBookCharacters(
      characters,
      {
        花: state({ repetitions: 0 }),
        山: state({ repetitions: 3 }),
        水: state({ repetitions: 1 }),
      },
      { 花: 9, 山: 4, 水: 4 },
      'reviewCount',
    )

    expect(sorted).toEqual(['花', '水', '山', '雨'])
    expect(
      sortWordBookCharacters(
        characters,
        {
          花: state({ repetitions: 0 }),
          山: state({ repetitions: 3 }),
          水: state({ repetitions: 1 }),
        },
        { 花: 9, 山: 4, 水: 4 },
        'reviewCount',
        'asc',
      ),
    ).toEqual(['水', '山', '花', '雨'])
    expect(characters).toEqual(['水', '花', '雨', '山'])
  })

  it('sorts learned characters by next review date, keeping unlearned last', () => {
    expect(sortWordBookCharacters(['花', '雨', '水', '山'], progress, {}, 'nextReview')).toEqual([
      '山',
      '水',
      '花',
      '雨',
    ])
  })

  it('supports descending next-review order while keeping unlearned characters last', () => {
    expect(
      sortWordBookCharacters(['花', '雨', '水', '山'], progress, {}, 'nextReview', 'desc'),
    ).toEqual(['花', '水', '山', '雨'])
  })

  it('preserves the existing word-book order in manual mode', () => {
    const characters = ['山', '花', '雨']
    expect(sortWordBookCharacters(characters, progress, {}, 'manual')).toEqual(characters)
  })

  it('filters by the existing proficiency classification', () => {
    expect(filterCharactersByProficiency(['花', '山', '水', '雨'], progress, 'mastered')).toEqual([
      '花',
    ])
    expect(filterCharactersByProficiency(['花', '山', '水', '雨'], progress, 'weak')).toEqual([
      '山',
    ])
    expect(filterCharactersByProficiency(['花', '山', '水', '雨'], progress, 'all')).toEqual([
      '花',
      '山',
      '水',
      '雨',
    ])
  })
})
