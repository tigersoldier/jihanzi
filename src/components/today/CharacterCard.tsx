import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { getPinyin, getWords } from '../../utils/chars'
import type { SM2State } from '../../core/types'
import LearningCharacter from '../common/LearningCharacter'

interface CharacterCardProps {
  character: string
  isNew: boolean
  sm2State?: SM2State
  ratingAnimation?: string | null // 'a' | 'b' | 'c' | 'd' | null
  slideDirection?: 'in' | 'out' | null
  autoHide?: boolean
  onFontReadyChange?: (character: string, isReady: boolean) => void
}

const REVEAL_DURATION_MS = 1000
const REVEAL_COOLDOWN_MS = 3000
const LONG_PRESS_DURATION_MS = 500
const LONG_PRESS_MOVE_THRESHOLD_PX = 10

const gradeColors: Record<string, string> = {
  a: 'bg-green-500',
  b: 'bg-yellow-500',
  c: 'bg-orange-500',
  d: 'bg-red-500',
}

const gradeIcons: Record<string, string> = {
  a: '✓',
  b: '~',
  c: '?',
  d: '✗',
}

export default function CharacterCard({
  character,
  isNew,
  sm2State,
  ratingAnimation,
  slideDirection,
  autoHide = false,
  onFontReadyChange,
}: CharacterCardProps) {
  const [isRevealed, setIsRevealed] = useState(true)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const cooldownUntilRef = useRef(0)
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressOriginRef = useRef<{ x: number; y: number } | null>(null)
  const pinyin = getPinyin(character)
  const words = getWords(character)
  const maskedWords = words.map(word => word.split(character).join('～'))

  const hideCharacter = useCallback(() => {
    const hiddenAt = Date.now()
    const nextRevealAt = hiddenAt + REVEAL_COOLDOWN_MS
    cooldownUntilRef.current = nextRevealAt
    setCooldownUntil(nextRevealAt)
    setNow(hiddenAt)
    setIsRevealed(false)
  }, [])

  useEffect(() => {
    if (!autoHide) return
    hideTimerRef.current = setTimeout(hideCharacter, REVEAL_DURATION_MS)
    return () => {
      if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
      if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current)
      longPressOriginRef.current = null
    }
  }, [autoHide, hideCharacter])

  useEffect(() => {
    if (!autoHide || isRevealed || cooldownUntil <= now) return
    const remainingMs = cooldownUntil - now
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, remainingMs))
    return () => clearTimeout(timer)
  }, [autoHide, cooldownUntil, isRevealed, now])

  const secondsUntilReveal = Math.ceil(Math.max(0, cooldownUntil - now) / 1000)
  const isCharacterHidden = autoHide && !isRevealed

  const handleReveal = () => {
    const revealedAt = Date.now()
    if (!autoHide || isRevealed || revealedAt < cooldownUntilRef.current) return

    setNow(revealedAt)
    setIsRevealed(true)
    if (hideTimerRef.current !== null) clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(hideCharacter, REVEAL_DURATION_MS)
  }

  const cancelLongPress = () => {
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressOriginRef.current = null
  }

  const startLongPress = (event: PointerEvent<HTMLButtonElement>) => {
    if (secondsUntilReveal > 0) return
    cancelLongPress()
    longPressOriginRef.current = { x: event.clientX, y: event.clientY }
    longPressTimerRef.current = setTimeout(() => {
      longPressTimerRef.current = null
      longPressOriginRef.current = null
      handleReveal()
    }, LONG_PRESS_DURATION_MS)
  }

  const handleLongPressMove = (event: PointerEvent<HTMLButtonElement>) => {
    const origin = longPressOriginRef.current
    if (!origin) return

    const distance = Math.hypot(event.clientX - origin.x, event.clientY - origin.y)
    if (distance > LONG_PRESS_MOVE_THRESHOLD_PX) cancelLongPress()
  }

  return (
    <div className="relative">
      <div
        className={`
          bg-white rounded-2xl shadow-sm border border-gray-100 p-6 sm:p-8
          flex flex-col items-center
          transition-all duration-300
          ${slideDirection === 'in' ? 'animate-slide-in' : ''}
          ${slideDirection === 'out' ? 'animate-slide-out' : ''}
        `}
      >
        {/* New badge */}
        {isNew && (
          <span className="absolute top-3 left-3 bg-indigo-100 text-indigo-700 text-xs font-medium px-2 py-0.5 rounded-full">
            新字
          </span>
        )}

        {/* Review count */}
        {sm2State && sm2State.repetitions > 0 && (
          <span className="absolute top-3 right-3 text-xs text-gray-400">
            复习 {sm2State.repetitions} 次
          </span>
        )}

        <div className="relative w-full min-h-[12.5rem] sm:min-h-[14.5rem] flex flex-col items-center justify-center">
          <div className="relative flex w-full justify-center">
            {/* Character display */}
            <div className="w-32 h-32 sm:w-40 sm:h-40 flex items-center justify-center mb-4">
              <div
                aria-hidden={isCharacterHidden || undefined}
                className={isCharacterHidden ? 'invisible' : ''}
              >
                <LearningCharacter
                  character={character}
                  className="text-7xl sm:text-8xl text-gray-900 select-none"
                  onFontReadyChange={onFontReadyChange}
                />
              </div>
            </div>

            {isCharacterHidden && (
              <button
                type="button"
                onClick={event => {
                  if (event.detail === 0) handleReveal()
                }}
                onPointerDown={startLongPress}
                onPointerMove={handleLongPressMove}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
                onContextMenu={event => event.preventDefault()}
                disabled={secondsUntilReveal > 0}
                aria-label={
                  secondsUntilReveal > 0
                    ? `长按显示生字，${secondsUntilReveal} 秒后可用`
                    : '长按显示生字'
                }
                className="absolute inset-0 w-full flex flex-col items-center justify-center rounded-xl text-gray-500 hover:bg-gray-50 disabled:cursor-not-allowed disabled:hover:bg-transparent focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500 select-none"
              >
                {secondsUntilReveal > 0 ? (
                  <>
                    <span className="text-base font-medium">生字已隐藏</span>
                    <span className="text-sm mt-2">{secondsUntilReveal} 秒后可再次显示</span>
                  </>
                ) : (
                  <>
                    <span className="text-base font-medium">长按揭晓生字</span>
                    <span className="text-sm mt-2">按住约 0.5 秒，显示 1 秒</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* 自动隐藏时仍显示拼音。 */}
          <p className="text-lg text-gray-500 mb-2 font-medium tracking-wide">{pinyin}</p>

          {/* 词例中的当前字替换为波浪号 */}
          {maskedWords.length > 0 && (
            <p className="text-sm text-gray-400">{maskedWords.join(' · ')}</p>
          )}
        </div>

        {/* Rating animation overlay */}
        {ratingAnimation && (
          <div
            className={`absolute inset-0 rounded-2xl flex items-center justify-center bg-white/80 backdrop-blur-sm transition-opacity duration-200`}
          >
            <div
              className={`w-20 h-20 ${gradeColors[ratingAnimation]} rounded-full flex items-center justify-center text-white text-3xl font-bold shadow-lg animate-pop`}
            >
              {gradeIcons[ratingAnimation]}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
