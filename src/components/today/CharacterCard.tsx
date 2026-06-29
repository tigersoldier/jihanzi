import { getPinyin, getWords } from '../../utils/chars'
import type { SM2State } from '../../core/types'

interface CharacterCardProps {
  character: string
  isNew: boolean
  sm2State?: SM2State
  ratingAnimation?: string | null  // 'a' | 'b' | 'c' | 'd' | null
  slideDirection?: 'in' | 'out' | null
}

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
}: CharacterCardProps) {
  const pinyin = getPinyin(character)
  const words = getWords(character)

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

        {/* Character display */}
        <div className="w-32 h-32 sm:w-40 sm:h-40 flex items-center justify-center mb-4">
          <span className="text-7xl sm:text-8xl font-kai text-gray-900 select-none">
            {character}
          </span>
        </div>

        {/* Pinyin */}
        <p className="text-lg text-gray-500 mb-2 font-medium tracking-wide">
          {pinyin}
        </p>

        {/* Example words */}
        {words.length > 0 && (
          <p className="text-sm text-gray-400">
            {words.join(' · ')}
          </p>
        )}

        {/* Rating animation overlay */}
        {ratingAnimation && (
          <div className={`absolute inset-0 rounded-2xl flex items-center justify-center bg-white/80 backdrop-blur-sm transition-opacity duration-200`}>
            <div className={`w-20 h-20 ${gradeColors[ratingAnimation]} rounded-full flex items-center justify-center text-white text-3xl font-bold shadow-lg animate-pop`}>
              {gradeIcons[ratingAnimation]}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
