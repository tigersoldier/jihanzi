import { useEffect, useState } from 'react'
import { todayKey } from '../utils/date'

/** Keep the local day key current across midnight and background-tab suspension. */
export function useTodayDateKey(): string {
  const [dateKey, setDateKey] = useState(todayKey)

  useEffect(() => {
    let timeoutId: number | undefined

    const updateAndSchedule = () => {
      const now = new Date()
      const nextMidnight = new Date(now)
      nextMidnight.setHours(24, 0, 0, 0)
      setDateKey(todayKey())
      timeoutId = window.setTimeout(
        updateAndSchedule,
        Math.max(1, nextMidnight.getTime() - now.getTime() + 50),
      )
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden') return
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      updateAndSchedule()
    }

    updateAndSchedule()
    document.addEventListener('visibilitychange', refreshWhenVisible)
    window.addEventListener('focus', refreshWhenVisible)

    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
      window.removeEventListener('focus', refreshWhenVisible)
    }
  }, [])

  return dateKey
}
