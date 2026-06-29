import { useState } from 'react'
import { useWordBook } from '../../hooks/useWordBook'
import { useApp } from '../../state/AppContext'
import WordBookSwitcher from './WordBookSwitcher'
import CharacterList from './CharacterList'
import EmptyState from '../common/EmptyState'

export default function WordBookPage() {
  const { state } = useApp()
  const {
    selectedWBId,
    setSelectedWBId,
    wbList,
    currentWB,
    addCharacter,
    removeCharacter,
    reorderCharacters,
    createWB,
    deleteWB,
  } = useWordBook()

  const [newCharInput, setNewCharInput] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newWBName, setNewWBName] = useState('')

  const handleAddChar = async () => {
    if (!newCharInput.trim()) return
    await addCharacter(newCharInput.trim())
    setNewCharInput('')
  }

  const handleCreateWB = async () => {
    if (!newWBName.trim()) return
    await createWB(newWBName.trim())
    setNewWBName('')
    setShowCreateForm(false)
  }

  // No word books created yet
  if (state.wordBooks.length === 0) {
    return (
      <div>
        <EmptyState
          icon="📚"
          title="还没有生字本"
          description="创建生字本或从文件导入，为学习准备字库。"
          action={{
            label: '创建生字本',
            onClick: () => setShowCreateForm(true),
          }}
        />

        {showCreateForm && (
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4 mt-4">
            <h3 className="font-bold text-gray-800">创建新字本</h3>
            <input
              type="text"
              value={newWBName}
              onChange={e => setNewWBName(e.target.value)}
              placeholder="生字本名称，如：人教版一年级上册"
              className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-300"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={handleCreateWB}
                disabled={!newWBName.trim()}
                className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
              >
                创建
              </button>
              <button
                onClick={() => setShowCreateForm(false)}
                className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
              >
                取消
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Word book switcher */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <WordBookSwitcher
            wbList={wbList}
            selectedWBId={selectedWBId}
            onSelect={setSelectedWBId}
          />
        </div>
        <button
          onClick={() => setShowCreateForm(true)}
          className="px-3 py-2 text-sm text-indigo-600 font-medium hover:bg-indigo-50 rounded-lg transition-colors whitespace-nowrap"
        >
          + 新建
        </button>
      </div>

      {/* Quick add input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={newCharInput}
          onChange={e => setNewCharInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAddChar()}
          placeholder="添加新字，如：雨"
          className="flex-1 px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-300"
        />
        <button
          onClick={handleAddChar}
          disabled={!newCharInput.trim()}
          className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
        >
          添加
        </button>
      </div>

      {/* Character count */}
      {currentWB && (
        <p className="text-sm text-gray-400">
          共 {currentWB.characters.length} 字
        </p>
      )}

      {/* Character list */}
      {currentWB && currentWB.characters.length > 0 ? (
        <CharacterList
          characters={currentWB.characters}
          onReorder={reorderCharacters}
          onRemove={removeCharacter}
        />
      ) : (
        <div className="text-center py-12 text-gray-400 text-sm">
          生字本为空，在上方输入框添加汉字
        </div>
      )}

      {/* Create form */}
      {showCreateForm && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 space-y-4">
          <h3 className="font-bold text-gray-800">创建新字本</h3>
          <input
            type="text"
            value={newWBName}
            onChange={e => setNewWBName(e.target.value)}
            placeholder="生字本名称"
            className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:border-indigo-300"
            autoFocus
          />
          <div className="flex gap-2">
            <button
              onClick={handleCreateWB}
              disabled={!newWBName.trim()}
              className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-40 transition-colors"
            >
              创建
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="flex-1 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-200 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
