import { useState, useMemo } from 'react'
import { useApp } from '../../state/AppContext'
import { useToday } from '../../hooks/useToday'
import { useHistory, type DaySummary } from '../../hooks/useStats'
import { todayKey, formatDateLabel, getDayTypeLabel, getDayType } from '../../utils/date'
import { GRADE_LABELS, GRADE_COLORS, type Grade } from '../../core/types'
import ProgressBar from './ProgressBar'
import CharacterCard from './CharacterCard'
import RatingButtons from './RatingButtons'
import RoundComplete from './RoundComplete'
import Celebration from './Celebration'
import CharacterDetail from '../common/CharacterDetail'
import EmptyState from '../common/EmptyState'

function currentYearMonth(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return `${y}年${m}月`
}

function prevMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (m === 1) return `${y - 1}-12`
  return `${y}-${String(m - 1).padStart(2, '0')}`
}

function nextMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  if (m === 12) return `${y + 1}-01`
  return `${y}-${String(m + 1).padStart(2, '0')}`
}

// ============================================================
// TodaySession — self-contained learning session UI.
// Calls useToday() internally so it only runs when mounted.
// ============================================================

export function TodaySession() {
  const { state, setSelectedChildId } = useApp()
  const today = useToday()
  const {
    phase,
    dayType,
    currentTask,
    taskIndex,
    totalTasks,
    round,
    sessionStats,
    ratingAnimation,
    children,
    selectedChildId,
    handleRate,
    startSession,
    handleContinueRound,
    handleSkipRound,
    handleDone,
    isReady,
  } = today

  return (
    <div className="space-y-4">
      {/* Child selector when multiple children */}
      {children.length > 1 && (
        <div className="flex justify-end">
          <select
            value={selectedChildId}
            onChange={e => setSelectedChildId(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          >
            {children.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}

      {/* Idle state */}
      {phase === 'idle' && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
          <div className="text-6xl mb-4">{dayType === '学新日' ? '📖' : '📝'}</div>
          <h2 className="text-xl font-bold text-gray-800 mb-2">
            {isReady ? `准备复习 ${totalTasks} 个字` : '今天没有需要复习的字'}
          </h2>
          <p className="text-gray-400 text-sm mb-6">
            {dayType === '学新日' ? '学新日：复习 + 新字学习' : '纯复习日：巩固已学汉字'}
          </p>
          {isReady && (
            <button
              onClick={startSession}
              className="w-full py-3 px-6 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors"
            >
              开始学习
            </button>
          )}
        </div>
      )}

      {/* Reviewing phase */}
      {phase === 'reviewing' && currentTask && (
        <div className="space-y-4">
          {round > 1 && (
            <div className="text-center">
              <span className="inline-block bg-amber-100 text-amber-700 text-xs font-medium px-3 py-1 rounded-full">
                第 {round} 轮
              </span>
            </div>
          )}
          <ProgressBar current={taskIndex} total={totalTasks} />
          <CharacterCard
            character={currentTask.character}
            isNew={currentTask.isNew}
            sm2State={currentTask.sm2State}
            ratingAnimation={ratingAnimation}
            slideDirection="in"
          />
          <RatingButtons onRate={handleRate} />
        </div>
      )}

      {/* Round complete */}
      {phase === 'roundComplete' && (
        <RoundComplete
          round={round}
          needReview={sessionStats.c + sessionStats.d}
          maxRounds={state.settings.maxRounds}
          onContinue={handleContinueRound}
          onSkip={handleSkipRound}
        />
      )}

      {/* Celebration */}
      {phase === 'celebration' && (
        <Celebration
          total={sessionStats.a + sessionStats.b + sessionStats.c + sessionStats.d}
          stats={sessionStats}
          onDone={handleDone}
        />
      )}
    </div>
  )
}

export default function ProgressPage() {
  const { state, selectedChildId, setSelectedChildId } = useApp()
  const tKey = todayKey()
  const curYM = currentYearMonth()

  const [viewMonth, setViewMonth] = useState(curYM)
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [detailChar, setDetailChar] = useState<string | null>(null)

  const isCurrentMonth = viewMonth === curYM

  // Header values — computed without useToday
  const dateLabel = formatDateLabel(tKey)
  const dayType = getDayTypeLabel(getDayType(tKey))
  const dayChildren = state.children.map(c => ({ id: c.id, name: c.name, hasTasks: true }))

  const activeChildId = selectedChildId || state.children[0]?.id || ''

  // ---- Monthly history ----
  const history = useHistory(activeChildId, viewMonth)
  const selectedDaySummary = useMemo(() => {
    if (!selectedDay) return null
    return history.days.find(d => d.dayKey === selectedDay) ?? null
  }, [history.days, selectedDay])

  // ---- Navigation ----
  // Character detail sub-view (highest priority)
  if (detailChar && activeChildId) {
    return (
      <CharacterDetail
        childId={activeChildId}
        character={detailChar}
        onBack={() => setDetailChar(null)}
      />
    )
  }

  // Day detail sub-view
  if (selectedDay && selectedDaySummary) {
    return (
      <DayDetailView
        daySummary={selectedDaySummary}
        onBack={() => setSelectedDay(null)}
        onCharClick={char => setDetailChar(char)}
      />
    )
  }

  // No children
  if (state.children.length === 0) {
    return (
      <EmptyState
        icon="👶"
        title="还没有学习记录"
        description="去「孩子」添加学习者，去「生字本」准备字库吧。"
      />
    )
  }

  // No word books
  if (state.wordBooks.length === 0) {
    return (
      <EmptyState
        icon="📚"
        title="还没有生字本"
        description="先去「生字本」创建或导入生字本，为学习准备字库。"
      />
    )
  }

  return (
    <div className="space-y-6">
      {/* Header: date + day type + child selector */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{dateLabel}</p>
          <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${
            dayType === '学新日' ? 'bg-indigo-100 text-indigo-700' : 'bg-teal-100 text-teal-700'
          }`}>
            {dayType}
          </span>
        </div>
        {dayChildren.length > 1 && (
          <select
            value={activeChildId}
            onChange={e => setSelectedChildId(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          >
            {dayChildren.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        {dayChildren.length === 1 && (
          <span className="text-sm text-gray-500">{dayChildren[0]?.name}</span>
        )}
      </div>

      {/* ---- Today's tasks (only in current month) ---- */}
      {isCurrentMonth && <TodaySession />}
      {isCurrentMonth && <div className="border-t border-gray-200" />}

      {/* ---- Monthly history ---- */}
      <div>
        {/* Month navigator */}
        <div className="flex items-center justify-between mb-3">
          <button
            onClick={() => setViewMonth(prevMonth(viewMonth))}
            className="text-sm text-indigo-600 hover:text-indigo-800 px-2 py-1"
          >
            ← 上月
          </button>
          <h3 className="text-sm font-medium text-gray-600">{monthLabel(viewMonth)}</h3>
          <button
            onClick={() => {
              const next = nextMonth(viewMonth)
              // Don't go past current month
              if (next <= curYM) setViewMonth(next)
            }}
            disabled={viewMonth >= curYM}
            className="text-sm text-indigo-600 hover:text-indigo-800 px-2 py-1 disabled:opacity-30 disabled:cursor-default"
          >
            下月 →
          </button>
        </div>

        {/* Day list */}
        {history.days.length === 0 ? (
          <div className="text-center py-8 text-gray-400 text-sm">
            {isCurrentMonth ? '本月暂无学习记录' : '该月暂无学习记录'}
          </div>
        ) : (
          <div className="space-y-2">
            {history.days.map(day => (
              <button
                key={day.dayKey}
                onClick={() => setSelectedDay(day.dayKey)}
                className="w-full bg-white rounded-xl border border-gray-100 px-4 py-3 shadow-sm hover:shadow-md transition-shadow text-left"
              >
                <DaySummaryRow day={day} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================
// Day summary row (in the month list)
// ============================================================

function DaySummaryRow({ day }: { day: DaySummary }) {
  const dayLabel = formatDateLabel(day.dayKey)
  const dayTypeLabel = getDayTypeLabel(day.dayType)
  const dateNum = day.dayKey.slice(-2).replace(/^0/, '')

  return (
    <div>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm font-medium text-gray-700">
          📅 {dateNum}日
        </span>
        <span className={`text-xs px-1.5 py-0.5 rounded-full ${
          day.dayType === 'learn' ? 'bg-indigo-100 text-indigo-600' : 'bg-teal-100 text-teal-600'
        }`}>
          {dayTypeLabel}
        </span>
        <span className="text-xs text-gray-400">{dayLabel}</span>
      </div>

      {day.newChars.length > 0 && (
        <div className="text-xs text-gray-500 ml-1">
          新学：{day.newChars.map(c => c.character).join('、')}
        </div>
      )}
      {day.reviewChars.length > 0 && (
        <div className="text-xs text-gray-500 ml-1">
          复习：{day.reviewChars.slice(0, 5).map(c => {
            const g = c.grade
            const sym = g === 'a' ? '✓' : g === 'b' ? '✓' : g === 'c' ? '△' : '✗'
            return `${c.character}(${sym})`
          }).join(' ')}{day.reviewChars.length > 5 ? ` … 共${day.reviewChars.length}字` : ''}
        </div>
      )}
      <div className="text-xs text-gray-400 mt-1 ml-1">
        Round1: a {day.stats.a} · b {day.stats.b} · c {day.stats.c} · d {day.stats.d}
      </div>
    </div>
  )
}

// ============================================================
// Day detail view (click into a specific day)
// ============================================================

function DayDetailView({
  daySummary,
  onBack,
  onCharClick,
}: {
  daySummary: DaySummary
  onBack: () => void
  onCharClick: (char: string) => void
}) {
  const dayLabel = formatDateLabel(daySummary.dayKey)
  const dayTypeLabel = getDayTypeLabel(daySummary.dayType)

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-sm text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
      >
        ← 返回月历
      </button>

      {/* Day header */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
        <p className="text-sm text-gray-500">{dayLabel}</p>
        <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${
          daySummary.dayType === 'learn' ? 'bg-indigo-100 text-indigo-700' : 'bg-teal-100 text-teal-700'
        }`}>
          {dayTypeLabel}
        </span>
        <div className="flex gap-4 mt-3 text-sm">
          <span>总字数: <strong>{daySummary.totalCount}</strong></span>
          <span>新学: <strong>{daySummary.newChars.length}</strong></span>
          <span>复习: <strong>{daySummary.reviewChars.length}</strong></span>
          <span className="text-gray-400">
            a{daySummary.stats.a} b{daySummary.stats.b} c{daySummary.stats.c} d{daySummary.stats.d}
          </span>
        </div>
      </div>

      {/* New characters */}
      {daySummary.newChars.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-2">🆕 新学字</h3>
          <div className="space-y-1">
            {daySummary.newChars.map(({ character, grade }) => (
              <button
                key={character}
                onClick={() => onCharClick(character)}
                className="w-full flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
              >
                <span className="text-lg font-kai text-gray-800">{character}</span>
                <span className={`text-sm font-medium ${GRADE_COLORS[grade]}`}>
                  {GRADE_LABELS[grade as Grade]}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Review characters */}
      {daySummary.reviewChars.length > 0 && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
          <h3 className="text-sm font-medium text-gray-500 mb-2">📝 复习字</h3>
          <div className="space-y-1">
            {daySummary.reviewChars.map(({ character, grade }) => (
              <button
                key={character}
                onClick={() => onCharClick(character)}
                className="w-full flex items-center justify-between py-2 px-3 rounded-lg hover:bg-gray-50 transition-colors text-left"
              >
                <span className="text-lg font-kai text-gray-800">{character}</span>
                <span className={`text-sm font-medium ${GRADE_COLORS[grade]}`}>
                  {GRADE_LABELS[grade as Grade]}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Day stats bar */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4">
        <h3 className="text-sm font-medium text-gray-500 mb-2">📊 Round 1 评级分布</h3>
        <div className="grid grid-cols-4 gap-2 text-center">
          {(['a', 'b', 'c', 'd'] as const).map(g => (
            <div key={g}>
              <div className={`text-xl font-bold ${GRADE_COLORS[g]}`}>{daySummary.stats[g]}</div>
              <div className="text-xs text-gray-400">{g}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
