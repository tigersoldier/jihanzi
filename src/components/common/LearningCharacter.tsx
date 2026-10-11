import { useEffect, useState } from 'react'
import { isLearningKaiGlyphSupported } from '../../utils/learningFontCoverage'
import { loadLearningKaiFont } from '../../utils/learningFont'

interface LearningCharacterProps {
  character: string
  className?: string
  onFontReadyChange?: (character: string, isReady: boolean) => void
}

type FontStatus = 'loading' | 'ready' | 'error'

/** 仅在内嵌楷体和对应字形都可用时显示大字，避免系统字体逐字回退。 */
export default function LearningCharacter({
  character,
  className = '',
  onFontReadyChange,
}: LearningCharacterProps) {
  const isSupported = isLearningKaiGlyphSupported(character)
  const [attempt, setAttempt] = useState(0)
  const [fontState, setFontState] = useState<{ character: string; status: FontStatus } | null>(null)

  useEffect(() => {
    onFontReadyChange?.(character, false)
    if (!isSupported) return

    let cancelled = false
    setFontState({ character, status: 'loading' })
    loadLearningKaiFont(character).then(
      () => {
        if (!cancelled) {
          setFontState({ character, status: 'ready' })
          onFontReadyChange?.(character, true)
        }
      },
      () => {
        if (!cancelled) {
          setFontState({ character, status: 'error' })
          onFontReadyChange?.(character, false)
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [attempt, character, isSupported, onFontReadyChange])

  if (!isSupported) {
    return (
      <span className="font-sans text-xs text-amber-700" role="alert">
        该字暂未收录于楷体字库，无法提供示范字形。
      </span>
    )
  }

  const status = fontState?.character === character ? fontState.status : 'loading'
  if (status === 'ready') {
    return (
      <span className={`font-learning-kai ${className}`} aria-label={character}>
        {character}
      </span>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex items-center gap-1 font-sans text-xs text-amber-700">
        <span role="alert">楷体加载失败。</span>
        <button
          type="button"
          className="underline"
          onClick={() => setAttempt(previous => previous + 1)}
        >
          点击重试
        </button>
      </div>
    )
  }

  return (
    <span className="font-sans text-xs text-gray-400" role="status">
      正在加载楷体…
    </span>
  )
}
