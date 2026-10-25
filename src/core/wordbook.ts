import type { SM2State } from './types'
import { getProficiency, type Proficiency } from './proficiency'

export type WordBookSortMode = 'manual' | 'reviewCount' | 'nextReview'
export type WordBookProficiencyFilter = 'all' | Exclude<Proficiency, 'unlearned'>

/** Filter a word-book list by the selected familiarity level. */
export function filterCharactersByProficiency(
  characters: string[],
  progress: Record<string, SM2State>,
  proficiencyFilter: WordBookProficiencyFilter,
): string[] {
  if (proficiencyFilter === 'all') return characters
  return characters.filter(char => getProficiency(progress[char]) === proficiencyFilter)
}

/**
 * Sort learned characters by review count or next review date. Unlearned
 * characters remain at the end, and ties retain their current word-book order.
 */
export function sortWordBookCharacters(
  characters: string[],
  progress: Record<string, SM2State>,
  reviewCounts: Record<string, number>,
  sortMode: WordBookSortMode,
): string[] {
  if (sortMode === 'manual') return [...characters]

  const originalOrder = new Map(characters.map((char, index) => [char, index]))
  const getOriginalOrder = (char: string) => originalOrder.get(char) ?? 0
  return [...characters].sort((a, b) => {
    const aState = progress[a]
    const bState = progress[b]
    if (!aState || !bState) {
      if (!aState && bState) return 1
      if (aState && !bState) return -1
      return getOriginalOrder(a) - getOriginalOrder(b)
    }

    const comparison =
      sortMode === 'reviewCount'
        ? (reviewCounts[b] ?? 0) - (reviewCounts[a] ?? 0)
        : aState.nextReview.localeCompare(bState.nextReview)
    return comparison || getOriginalOrder(a) - getOriginalOrder(b)
  })
}
