import { describe, it, expect } from 'vitest'
import { GRADE_LABELS, GRADE_COLORS, type Grade } from './types'

describe('GRADE_LABELS', () => {
  it('covers all four grade values', () => {
    const grades: Grade[] = ['a', 'b', 'c', 'd']
    for (const g of grades) {
      expect(GRADE_LABELS[g]).toBeTypeOf('string')
      expect(GRADE_LABELS[g].length).toBeGreaterThan(0)
    }
  })
})

describe('GRADE_COLORS', () => {
  it('covers all four grade values', () => {
    const grades: Grade[] = ['a', 'b', 'c', 'd']
    for (const g of grades) {
      expect(GRADE_COLORS[g]).toBeTypeOf('string')
      expect(GRADE_COLORS[g].length).toBeGreaterThan(0)
    }
  })
})
