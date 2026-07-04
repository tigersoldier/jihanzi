import type { SM2State } from './types'

// ============================================================
// Proficiency — derived classification of how well a character
// is known, computed from its SM-2 memory state.
// ============================================================

export type Proficiency = 'mastered' | 'progressing' | 'weak' | 'unlearned'

/**
 * Classify a character's proficiency level from its SM-2 state.
 *
 * - mastered:  last grade 'a' with ≥3 successful repetitions (well consolidated)
 * - weak:      last grade 'd' (forgotten), or 'c' with <2 repetitions (struggling)
 * - progressing: everything else (actively learning)
 * - unlearned: no SM-2 state yet (never reviewed)
 */
export function getProficiency(sm2State: SM2State | undefined): Proficiency {
  if (!sm2State) return 'unlearned'
  if (sm2State.lastGrade === 'a' && sm2State.repetitions >= 3) return 'mastered'
  if (sm2State.lastGrade === 'd' || (sm2State.lastGrade === 'c' && sm2State.repetitions < 2)) return 'weak'
  return 'progressing'
}

export const PROFICIENCY_COLORS: Record<Proficiency, string> = {
  mastered: 'bg-green-100 text-green-700 border-green-300',
  progressing: 'bg-blue-100 text-blue-700 border-blue-300',
  weak: 'bg-yellow-100 text-yellow-700 border-yellow-300',
  unlearned: 'bg-gray-100 text-gray-400 border-gray-200',
}

export const PROFICIENCY_DOT: Record<Proficiency, string> = {
  mastered: '🟢',
  progressing: '🔵',
  weak: '🟡',
  unlearned: '⚪',
}
