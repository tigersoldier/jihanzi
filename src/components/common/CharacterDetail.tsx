import { useCharacterStats } from '../../hooks/useStats'
import { getCharInfo } from '../../utils/chars'
import { formatDateLabel, getDayTypeLabel, getDayType } from '../../utils/date'
import { GRADE_LABELS, GRADE_COLORS } from '../../core/types'

interface CharacterDetailProps {
  childId: string
  character: string
  onBack: () => void
}

export default function CharacterDetail({ childId, character, onBack }: CharacterDetailProps) {
  const { sm2State, totalReviews, gradeCounts, timeline, loading } = useCharacterStats(childId, character)
  const { pinyin, words } = getCharInfo(character)

  return (
    <div className="space-y-4">
      {/* Header */}
      <button
        onClick={onBack}
        className="text-sm text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
      >
        ← 返回
      </button>

      {/* Character display */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
        <div className="text-7xl font-bold text-gray-800 mb-2">{character}</div>
        <div className="text-lg text-gray-500 mb-1">{pinyin}</div>
        {words.length > 0 && (
          <div className="text-sm text-gray-400">{words.join(' · ')}</div>
        )}
      </div>

      {/* Stats summary */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
        <h3 className="text-sm font-medium text-gray-500 mb-3">📊 学习统计</h3>
        {loading ? (
          <div className="grid grid-cols-5 gap-2 text-center">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i}>
                <div className="inline-block h-7 w-10 bg-gray-200 animate-pulse rounded mb-1" />
                <div className="text-xs text-gray-400">{i === 0 ? '总次数' : `${['a','b','c','d'][i-1]} · ${['完全掌握','部分正确','需提示','遗忘'][i-1]}`}</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-5 gap-2 text-center">
            <div>
              <div className="text-2xl font-bold text-gray-800">{totalReviews}</div>
              <div className="text-xs text-gray-400">总次数</div>
            </div>
            {(['a', 'b', 'c', 'd'] as const).map(g => (
              <div key={g}>
                <div className={`text-2xl font-bold ${GRADE_COLORS[g]}`}>
                  {gradeCounts[g]}
                </div>
                <div className="text-xs text-gray-400">{g} · {GRADE_LABELS[g]}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SM-2 State */}
      {loading ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-3">🧠 当前记忆状态</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i}>
                <span className="text-gray-400">{['难度系数','间隔','成功重复','下次复习'][i]}</span>
                <div className="h-5 w-20 bg-gray-200 animate-pulse rounded mt-1" />
              </div>
            ))}
          </div>
        </div>
      ) : sm2State && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-3">🧠 当前记忆状态</h3>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <span className="text-gray-400">难度系数</span>
              <div className="font-medium text-gray-800">{sm2State.ease.toFixed(2)}</div>
            </div>
            <div>
              <span className="text-gray-400">间隔</span>
              <div className="font-medium text-gray-800">{sm2State.interval} 天</div>
            </div>
            <div>
              <span className="text-gray-400">成功重复</span>
              <div className="font-medium text-gray-800">{sm2State.repetitions} 次</div>
            </div>
            <div>
              <span className="text-gray-400">下次复习</span>
              <div className="font-medium text-gray-800">{sm2State.nextReview}</div>
            </div>
          </div>
        </div>
      )}

      {/* Review timeline */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
        <h3 className="text-sm font-medium text-gray-500 mb-3">📅 学习轨迹</h3>
        {loading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex items-start gap-3 py-2">
                <div className="flex-shrink-0">
                  <div className="h-3 w-16 bg-gray-200 animate-pulse rounded mb-1" />
                  <div className="h-3 w-10 bg-gray-200 animate-pulse rounded" />
                </div>
                <div className="flex gap-1.5">
                  {Array.from({ length: 2 }).map((_, j) => (
                    <div key={j} className="h-5 w-14 bg-gray-200 animate-pulse rounded-full" />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : timeline.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-4">暂无学习记录</p>
        ) : (
          <div className="space-y-2">
            {timeline.map(({ dayKey, rounds }) => (
              <div key={dayKey} className="flex items-start gap-3 py-2 border-b border-gray-50 last:border-b-0">
                <div className="flex-shrink-0 min-w-0">
                  <div className="text-xs text-gray-500">{formatDateLabel(dayKey)}</div>
                  <div className="text-xs text-gray-400">{getDayTypeLabel(getDayType(dayKey))}</div>
                </div>
                <div className="flex gap-1.5 flex-wrap">
                  {rounds.map((r, i) => (
                    <span
                      key={i}
                      className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${GRADE_COLORS[r.grade]}`}
                    >
                      R{r.round}: {r.grade}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
