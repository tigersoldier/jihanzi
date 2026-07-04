import { describe, it, expect } from 'vitest'
import { getProficiency, type Proficiency } from './proficiency'
import type { SM2State } from './types'

function sm2(overrides?: Partial<SM2State>): SM2State {
  return {
    ease: 2.5,
    interval: 1,
    repetitions: 0,
    nextReview: '2026-01-02',
    lastGrade: 'a',
    ...overrides,
  }
}

describe('getProficiency', () => {
  it('returns unlearned when SM2State is undefined', () => {
    expect(getProficiency(undefined)).toBe('unlearned')
  })

  it('returns mastered when lastGrade is a and repetitions >= 3', () => {
    expect(getProficiency(sm2({ lastGrade: 'a', repetitions: 3 }))).toBe('mastered')
    expect(getProficiency(sm2({ lastGrade: 'a', repetitions: 5 }))).toBe('mastered')
  })

  it('returns progressing when lastGrade is a but repetitions < 3', () => {
    expect(getProficiency(sm2({ lastGrade: 'a', repetitions: 0 }))).toBe('progressing')
    expect(getProficiency(sm2({ lastGrade: 'a', repetitions: 2 }))).toBe('progressing')
  })

  it('returns progressing when lastGrade is b regardless of repetitions', () => {
    expect(getProficiency(sm2({ lastGrade: 'b', repetitions: 0 }))).toBe('progressing')
    expect(getProficiency(sm2({ lastGrade: 'b', repetitions: 5 }))).toBe('progressing')
  })

  it('returns weak when lastGrade is d regardless of repetitions', () => {
    expect(getProficiency(sm2({ lastGrade: 'd', repetitions: 0 }))).toBe('weak')
    expect(getProficiency(sm2({ lastGrade: 'd', repetitions: 10 }))).toBe('weak')
  })

  it('returns weak when lastGrade is c and repetitions < 2', () => {
    expect(getProficiency(sm2({ lastGrade: 'c', repetitions: 0 }))).toBe('weak')
    expect(getProficiency(sm2({ lastGrade: 'c', repetitions: 1 }))).toBe('weak')
  })

  it('returns progressing when lastGrade is c and repetitions >= 2', () => {
    expect(getProficiency(sm2({ lastGrade: 'c', repetitions: 2 }))).toBe('progressing')
    expect(getProficiency(sm2({ lastGrade: 'c', repetitions: 3 }))).toBe('progressing')
  })
})
