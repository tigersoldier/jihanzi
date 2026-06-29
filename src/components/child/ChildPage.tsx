import { useState } from 'react'
import { useChild } from '../../hooks/useChild'
import { useApp } from '../../state/AppContext'
import ChildSwitcher from './ChildSwitcher'
import EmptyState from '../common/EmptyState'

export default function ChildPage() {
  const { state, createWordBook: createWB } = useApp()
  const {
    currentChild,
    childList,
    hasPrevChild,
    hasNextChild,
    goToPrevChild,
    goToNextChild,
    createChild,
    deleteChild,
  } = useChild()

  const [showAddForm, setShowAddForm] = useState(false)
  const [newName, setNewName] = useState('')
  const [selectedWB, setSelectedWB] = useState(state.wordBooks[0]?.id || '')

  // No children created yet
  if (state.children.length === 0) {
    return (
      <div>
        <EmptyState
          icon="👶"
          title="还没有添加孩子"
          description="添加第一个孩子开始追踪学习进度。"
          action={{
            label: '添加孩子',
            onClick: () => setShowAddForm(true),
          }}
        />

        {showAddForm && (
          <AddChildForm
            name={newName}
            onNameChange={setNewName}
            wordBooks={state.wordBooks}
            selectedWB={selectedWB}
            onWBChange={setSelectedWB}
            onSubmit={async () => {
              if (newName.trim()) {
                // Auto-create a wordbook if none exists
                let wbId = selectedWB
                if (!wbId && state.wordBooks.length === 0) {
                  wbId = await createWB('默认生字本')
                }
                await createChild(newName.trim(), wbId)
                setNewName('')
                setShowAddForm(false)
              }
            }}
            onCancel={() => setShowAddForm(false)}
          />
        )}
      </div>
    )
  }

  if (!currentChild) {
    return <EmptyState icon="👶" title="请选择一个孩子" description="" />
  }

  const stats = currentChild.stats

  return (
    <div className="space-y-4">
      {/* Child switcher */}
      <ChildSwitcher
        name={currentChild.name}
        hasPrev={hasPrevChild}
        hasNext={hasNextChild}
        onPrev={goToPrevChild}
        onNext={goToNextChild}
      />

      {/* Stats */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
        <div className="text-center mb-4">
          <p className="text-3xl font-bold text-indigo-700">{stats.total}</p>
          <p className="text-sm text-gray-500">已学字数</p>
        </div>

        {/* Per-grade breakdown */}
        <div className="space-y-3">
          <StatRow color="bg-green-500" label="完全掌握" count={stats.a} percent={stats.aPercent} />
          <StatRow color="bg-yellow-500" label="部分正确" count={stats.b} percent={stats.bPercent} />
          <StatRow color="bg-orange-500" label="需提示" count={stats.c} percent={stats.cPercent} />
          <StatRow color="bg-red-500" label="遗忘" count={stats.d} percent={stats.dPercent} />
        </div>

        {/* Word book info */}
        <div className="mt-4 pt-4 border-t border-gray-100 text-center text-sm text-gray-400">
          生字本：{currentChild.wordBookName}
        </div>
      </div>

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={() => setShowAddForm(true)}
          className="flex-1 py-2 px-4 bg-indigo-600 text-white rounded-xl text-sm font-medium hover:bg-indigo-700 transition-colors"
        >
          添加孩子
        </button>
      </div>

      {showAddForm && (
        <AddChildForm
          name={newName}
          onNameChange={setNewName}
          wordBooks={state.wordBooks}
          selectedWB={selectedWB}
          onWBChange={setSelectedWB}
          onSubmit={async () => {
            if (newName.trim()) {
              await createChild(newName.trim(), selectedWB)
              setNewName('')
              setShowAddForm(false)
            }
          }}
          onCancel={() => setShowAddForm(false)}
        />
      )}
    </div>
  )
}

function StatRow({ color, label, count, percent }: { color: string; label: string; count: number; percent: number }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-gray-600 w-20">{label}</span>
      <div className="flex-1 h-2 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${percent}%` }} />
      </div>
      <span className="text-sm text-gray-500 w-12 text-right">{percent}%</span>
    </div>
  )
}

function AddChildForm({
  name, onNameChange, wordBooks, selectedWB, onWBChange, onSubmit, onCancel,
}: {
  name: string
  onNameChange: (v: string) => void
  wordBooks: { id: string; name: string }[]
  selectedWB: string
  onWBChange: (v: string) => void
  onSubmit: () => void
  onCancel: () => void
}) {
  return (
    <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
      <h3 className="font-bold text-gray-800">添加新孩子</h3>
      <input
        type="text"
        value={name}
        onChange={e => onNameChange(e.target.value)}
        placeholder="孩子名字"
        className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-300"
        autoFocus
      />
      {wordBooks.length > 0 && (
        <select
          value={selectedWB}
          onChange={e => onWBChange(e.target.value)}
          className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white"
        >
          <option value="">选择生字本</option>
          {wordBooks.map(wb => (
            <option key={wb.id} value={wb.id}>{wb.name}</option>
          ))}
        </select>
      )}
      <div className="flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!name.trim()}
          className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
        >
          确定
        </button>
        <button
          onClick={onCancel}
          className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
        >
          取消
        </button>
      </div>
    </div>
  )
}
