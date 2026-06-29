import { useToday } from '../../hooks/useToday'
import ProgressBar from './ProgressBar'
import CharacterCard from './CharacterCard'
import RatingButtons from './RatingButtons'
import RoundComplete from './RoundComplete'
import Celebration from './Celebration'
import EmptyState from '../common/EmptyState'
import { useApp } from '../../state/AppContext'

export default function TodayPage() {
  const { state } = useApp()
  const {
    phase,
    dayType,
    dateLabel,
    currentTask,
    taskIndex,
    totalTasks,
    round,
    sessionStats,
    ratingAnimation,
    selectedChildId,
    children,
    setSelectedChildId,
    handleRate,
    startSession,
    handleContinueRound,
    handleSkipRound,
    handleDone,
    isReady,
  } = useToday()

  // No children created yet
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
    <div className="space-y-4">
      {/* Header: date + day type */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{dateLabel}</p>
          <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full mt-1 ${
            dayType === '学新日' ? 'bg-indigo-100 text-indigo-700' : 'bg-teal-100 text-teal-700'
          }`}>
            {dayType}
          </span>
        </div>
        {/* Child selector when multiple children */}
        {children.length > 1 && (
          <select
            value={selectedChildId}
            onChange={e => setSelectedChildId(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white"
          >
            {children.map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
        {children.length === 1 && (
          <span className="text-sm text-gray-500">{children[0]?.name}</span>
        )}
      </div>

      {/* Idle state: show start button */}
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
          {/* Round indicator */}
          {round > 1 && (
            <div className="text-center">
              <span className="inline-block bg-amber-100 text-amber-700 text-xs font-medium px-3 py-1 rounded-full">
                第 {round} 轮
              </span>
            </div>
          )}

          {/* Progress bar */}
          <ProgressBar current={taskIndex} total={totalTasks} />

          {/* Character card */}
          <CharacterCard
            character={currentTask.character}
            isNew={currentTask.isNew}
            sm2State={currentTask.sm2State}
            ratingAnimation={ratingAnimation}
            slideDirection="in"
          />

          {/* Rating buttons */}
          <RatingButtons onRate={handleRate} />
        </div>
      )}

      {/* Round complete phase */}
      {phase === 'roundComplete' && (
        <RoundComplete
          round={round}
          needReview={sessionStats.c + sessionStats.d}
          maxRounds={state.settings.maxRounds}
          onContinue={handleContinueRound}
          onSkip={handleSkipRound}
        />
      )}

      {/* Celebration phase */}
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
