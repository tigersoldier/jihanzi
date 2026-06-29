import type { Grade } from '../../core/types'

interface RatingButtonsProps {
  onRate: (grade: Grade) => void
  disabled?: boolean
}

const ratings: { grade: Grade; label: string; sublabel: string; color: string; bg: string; border: string; hoverBg: string }[] = [
  { grade: 'a', label: '完全掌握', sublabel: '✓', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-300', hoverBg: 'hover:bg-green-100' },
  { grade: 'b', label: '部分正确', sublabel: '~', color: 'text-yellow-700', bg: 'bg-yellow-50', border: 'border-yellow-300', hoverBg: 'hover:bg-yellow-100' },
  { grade: 'c', label: '需提示', sublabel: '?', color: 'text-orange-700', bg: 'bg-orange-50', border: 'border-orange-300', hoverBg: 'hover:bg-orange-100' },
  { grade: 'd', label: '遗忘', sublabel: '✗', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-300', hoverBg: 'hover:bg-red-100' },
]

export default function RatingButtons({ onRate, disabled }: RatingButtonsProps) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-3">
      {ratings.map(r => (
        <button
          key={r.grade}
          onClick={() => onRate(r.grade)}
          disabled={disabled}
          className={`
            btn-rating ${r.bg} ${r.border} ${r.hoverBg} ${r.color}
            sm:flex-1
            disabled:opacity-40 disabled:cursor-not-allowed
          `}
        >
          <span className="text-xl font-bold">{r.sublabel}</span>
          <span className="text-xs mt-0.5">{r.label}</span>
        </button>
      ))}
    </div>
  )
}
