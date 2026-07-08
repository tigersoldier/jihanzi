import React from 'react'

interface PresentingButtonsProps {
  taskIndex: number
  totalTasks: number
  onPrev: () => void
  onNext: () => void
}

/** 展示阶段导航按钮：上一个 / 下一个（末尾字显示"开始复习"） */
export default function PresentingButtons({
  taskIndex,
  totalTasks,
  onPrev,
  onNext,
}: PresentingButtonsProps) {
  const isLast = taskIndex === totalTasks - 1

  return (
    <div className="flex gap-3">
      {taskIndex > 0 && (
        <button
          onClick={onPrev}
          className="flex-1 py-3 px-6 border border-gray-200 text-gray-700 rounded-xl font-medium hover:bg-gray-50 transition-colors"
        >
          上一个
        </button>
      )}
      <button
        onClick={onNext}
        className="flex-1 py-3 px-6 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-colors"
      >
        {isLast ? '开始复习' : '下一个'}
      </button>
    </div>
  )
}
