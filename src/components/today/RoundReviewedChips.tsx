import { GRADE_COLORS, GRADE_SYMBOLS, type Grade } from '../../core/types'

interface RoundReviewedChipsProps {
  /** 本轮已评字（按评级先后） */
  rated: { character: string; grade: Grade }[]
  /** 本轮队列长度 */
  total: number
}

/**
 * 会话中进度条下的「本轮已复习」列表：按评级上色，右下角带评级符号。
 * 本轮还没评过字时不渲染；轮次切换时由父组件传入新的空列表。
 */
export default function RoundReviewedChips({ rated, total }: RoundReviewedChipsProps) {
  if (rated.length === 0) return null

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs text-gray-400">
        <span>本轮已复习</span>
        <span className="tabular-nums">
          {rated.length} / {total}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {rated.map(({ character, grade }) => (
          <span
            key={character}
            className={`relative inline-flex h-7 w-7 items-center justify-center rounded-md text-sm font-medium ${GRADE_COLORS[grade]}`}
          >
            {character}
            <span className="absolute bottom-0 right-0.5 text-[9px] leading-none">
              {GRADE_SYMBOLS[grade]}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
