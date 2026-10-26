import { useEffect, useState } from 'react'
import { getReviewCountsForChild } from '../data/db'
import { useApp } from '../state/AppContextDefinition'

export type ReviewCountStatus = 'loading' | 'ready' | 'unavailable'

export interface WordBookReviewCounts {
  status: ReviewCountStatus
  counts: Record<string, number>
}

interface ReviewCountResult extends WordBookReviewCounts {
  childId: string
}

/** Load per-character review totals for the selected child's word-book list. */
export function useWordBookReviewCounts(childId: string | null): WordBookReviewCounts {
  const { dataVersion } = useApp()
  const [result, setResult] = useState<ReviewCountResult>({
    childId: '',
    status: 'loading',
    counts: {},
  })

  useEffect(() => {
    if (!childId) {
      setResult({ childId: '', status: 'ready', counts: {} })
      return
    }

    let cancelled = false
    setResult({ childId, status: 'loading', counts: {} })
    void (async () => {
      try {
        const counts = await getReviewCountsForChild(childId)
        if (!cancelled) setResult({ childId, status: 'ready', counts })
      } catch (error) {
        console.error('Failed to load word-book review counts:', error)
        if (!cancelled) setResult({ childId, status: 'unavailable', counts: {} })
      }
    })()

    return () => {
      cancelled = true
    }
  }, [childId, dataVersion])

  return result.childId === childId
    ? { status: result.status, counts: result.counts }
    : { status: childId ? 'loading' : 'ready', counts: {} }
}
