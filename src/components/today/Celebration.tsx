import ReadAloudReminder, { type RoundCharGroup } from './ReadAloudReminder'

interface CelebrationProps {
  total: number
  stats: { a: number; b: number; c: number; d: number }
  /** 本次会话各轮写过的汉字（朗读提醒用，按轮分组） */
  groups: RoundCharGroup[]
  onDone: () => void
}

export default function Celebration({ total, stats, groups, onDone }: CelebrationProps) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-8 text-center">
      {/* Checkmark */}
      <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
        <svg
          className="w-8 h-8 text-green-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>

      <h2 className="text-xl font-bold text-gray-800 mb-2">今天完成 {total} 个字</h2>

      {/* Stats breakdown */}
      <div className="grid grid-cols-2 gap-2 my-6">
        <StatItem color="text-green-600" bg="bg-green-50" label="完全掌握" count={stats.a} />
        <StatItem color="text-yellow-600" bg="bg-yellow-50" label="部分正确" count={stats.b} />
        <StatItem color="text-orange-600" bg="bg-orange-50" label="需提示" count={stats.c} />
        <StatItem color="text-red-600" bg="bg-red-50" label="遗忘" count={stats.d} />
      </div>

      {/* 朗读提醒：列出本次会话各轮写的字，请孩子都读一遍 */}
      {groups.length > 0 && (
        <div className="my-6">
          <ReadAloudReminder groups={groups} message="请让孩子把今天写的字都读一遍" />
        </div>
      )}

      <button
        onClick={onDone}
        className="w-full py-3 px-6 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors"
      >
        返回首页
      </button>
    </div>
  )
}

function StatItem({
  color,
  bg,
  label,
  count,
}: {
  color: string
  bg: string
  label: string
  count: number
}) {
  return (
    <div className={`${bg} rounded-xl p-3`}>
      <div className={`text-2xl font-bold ${color}`}>{count}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  )
}
