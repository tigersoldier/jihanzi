interface RoundCompleteProps {
  round: number
  needReview: number
  maxRounds: number
  onContinue: () => void
  onSkip: () => void
}

export default function RoundComplete({ round, needReview, maxRounds, onContinue, onSkip }: RoundCompleteProps) {
  const canContinue = round < maxRounds

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
      <div className="text-5xl mb-4">{round === 1 ? '💪' : '🔄'}</div>
      <h2 className="text-xl font-bold text-gray-800 mb-2">
        第 {round} 轮完成
      </h2>
      <p className="text-gray-500 mb-6">
        {needReview > 0
          ? `${needReview} 个字需要再巩固`
          : '全部掌握，太棒了！'
        }
      </p>

      {needReview > 0 && canContinue && (
        <div className="space-y-3">
          <button
            onClick={onContinue}
            className="w-full py-3 px-6 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors"
          >
            {round < maxRounds ? `开始第 ${round + 1} 轮巩固` : '开始巩固'}
          </button>
          <button
            onClick={onSkip}
            className="w-full py-3 px-6 text-gray-500 hover:text-gray-700 transition-colors text-sm"
          >
            跳过，今天就到这
          </button>
        </div>
      )}

      {needReview > 0 && !canContinue && (
        <div className="space-y-3">
          <p className="text-sm text-gray-400">已达到最大轮次上限</p>
          <button
            onClick={onSkip}
            className="w-full py-3 px-6 bg-gray-100 text-gray-700 rounded-xl font-medium hover:bg-gray-200 transition-colors"
          >
            返回首页
          </button>
        </div>
      )}

      {needReview === 0 && (
        <button
          onClick={onSkip}
          className="w-full py-3 px-6 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors"
        >
          太棒了，继续
        </button>
      )}
    </div>
  )
}
