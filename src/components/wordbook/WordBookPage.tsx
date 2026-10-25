import { useState } from 'react'
import { useWordBook } from '../../hooks/useWordBook'
import { useRoute } from '../../hooks/useRoute'
import { useApp } from '../../state/AppContext'
import type { WordBookRoute } from '../../router'
import WordBookSwitcher from './WordBookSwitcher'
import CharacterList from './CharacterList'
import CharacterDetail from '../common/CharacterDetail'
import EmptyState from '../common/EmptyState'
import { getProficiency } from '../../core/proficiency'
import {
  filterCharactersByProficiency,
  sortWordBookCharacters,
  type WordBookProficiencyFilter,
  type WordBookSortMode,
} from '../../core/wordbook'
import { useWordBookReviewCounts } from '../../hooks/useWordBookReviewCounts'

type FilterMode = 'all' | 'learned' | 'unlearned'

export default function WordBookPage() {
  const { state, selectedChildId, setSelectedChildId } = useApp()
  const { route, navigate, goBack } = useRoute()
  // WordBookPage 只在 activeTab === 'wordbook' 时被渲染，此处路由必为 wordbook
  const wbRoute = route as WordBookRoute
  const {
    selectedWBId,
    setSelectedWBId,
    wbList,
    currentWB,
    addCharacter,
    removeCharacter,
    reorderCharacters,
    createWB,
  } = useWordBook()

  const [newCharInput, setNewCharInput] = useState('')
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [newWBName, setNewWBName] = useState('')
  const [filterMode, setFilterMode] = useState<FilterMode>('all')
  const [sortMode, setSortMode] = useState<WordBookSortMode>('manual')
  const [proficiencyFilter, setProficiencyFilter] = useState<WordBookProficiencyFilter>('all')

  // 查看的生字由 URL 驱动（#/wordbook/char/<字>）
  const detailChar = wbRoute.char ?? null

  // Get current child's progress for proficiency lookup
  const currentChild = state.children.find(c => c.id === selectedChildId)
  const progress = currentChild?.progress ?? {}
  const reviewCountResult = useWordBookReviewCounts(selectedChildId || null)
  const reviewCounts = reviewCountResult.counts

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

  // Show character detail sub-view
  if (detailChar && selectedChildId) {
    return (
      <CharacterDetail
        childId={selectedChildId}
        character={detailChar}
        onBack={() => goBack({ name: 'wordbook', wbId: wbRoute.wbId ?? undefined })}
      />
    )
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

  // Filter characters by learned status and familiarity, then apply the selected sort.
  const allChars = currentWB?.characters ?? []
  const statusFilteredChars = allChars.filter(char => {
    const learned = char in progress
    if (filterMode === 'learned') return learned
    if (filterMode === 'unlearned') return !learned
    return true
  })
  const filteredChars = filterCharactersByProficiency(
    statusFilteredChars,
    progress,
    proficiencyFilter,
  )
  const effectiveSortMode =
    sortMode === 'reviewCount' && reviewCountResult.status !== 'ready' ? 'manual' : sortMode
  const canReorder =
    sortMode === 'manual' ||
    (sortMode === 'reviewCount' && reviewCountResult.status === 'unavailable')
  const displayedChars = sortWordBookCharacters(
    filteredChars,
    progress,
    reviewCounts,
    effectiveSortMode,
  )

  // Build proficiency map
  const proficiencyMap: Record<string, ReturnType<typeof getProficiency>> = {}
  for (const char of displayedChars) {
    proficiencyMap[char] = getProficiency(progress[char])
  }

  const learnedCount = allChars.filter(c => c in progress).length
  const isFilteredSubset = filterMode !== 'all' || proficiencyFilter !== 'all'
  const emptyListMessage =
    allChars.length === 0
      ? '生字本为空，在上方输入框添加汉字'
      : filterMode === 'learned' && learnedCount === 0
        ? '还没有已学字'
        : filterMode === 'unlearned' && learnedCount === allChars.length
          ? '所有字都已学过 ✨'
          : '没有符合筛选条件的汉字'

  const handleRemove = (char: string, _filteredIndex: number) => {
    const realIndex = allChars.indexOf(char)
    if (realIndex !== -1) removeCharacter(char, realIndex)
  }

  const handleReorder = (reorderedSubset: string[]) => {
    if (!canReorder) return
    if (!isFilteredSubset) {
      reorderCharacters(reorderedSubset)
      return
    }
    // Reconstruct the full array: unfiltered chars stay in place;
    // filtered chars are placed in their new relative order at the
    // positions that originally held filtered chars.
    const subsetSet = new Set(filteredChars)
    const result = [...allChars]
    let si = 0
    for (let i = 0; i < result.length; i++) {
      if (subsetSet.has(result[i])) {
        result[i] = reorderedSubset[si++]
      }
    }
    reorderCharacters(result)
  }

  return (
    <div className="space-y-4">
      {/* Child selector */}
      {state.children.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-400 whitespace-nowrap">当前孩子：</span>
          <select
            value={selectedChildId}
            onChange={e => setSelectedChildId(e.target.value)}
            className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white flex-1"
          >
            {state.children.map(c => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}

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

      {/* Filter tabs + count */}
      {currentWB && (
        <div className="flex items-center justify-between">
          <div className="flex gap-1 bg-gray-100 rounded-lg p-1">
            {(
              [
                ['all', '全部'],
                ['learned', `已学 ${learnedCount}`],
                ['unlearned', `未学 ${allChars.length - learnedCount}`],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setFilterMode(key)}
                className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                  filterMode === key
                    ? 'bg-white text-gray-800 shadow-sm'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-sm text-gray-400">共 {allChars.length} 字</p>
        </div>
      )}

      {/* Sort and familiarity filter */}
      {currentWB && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <label className="flex items-center gap-2 text-gray-500">
            排序
            <select
              aria-label="排序汉字"
              value={sortMode}
              onChange={e => setSortMode(e.target.value as WordBookSortMode)}
              className="border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700"
            >
              <option value="manual">字本顺序</option>
              <option value="reviewCount" disabled={reviewCountResult.status !== 'ready'}>
                复习次数（多到少）
              </option>
              <option value="nextReview">下次复习时间（近到远）</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-gray-500">
            熟悉程度
            <select
              aria-label="按熟悉程度筛选"
              value={proficiencyFilter}
              onChange={e => setProficiencyFilter(e.target.value as WordBookProficiencyFilter)}
              className="border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white text-gray-700"
            >
              <option value="all">不限</option>
              <option value="mastered">熟练</option>
              <option value="progressing">学习中</option>
              <option value="weak">薄弱</option>
            </select>
          </label>
          {reviewCountResult.status === 'loading' && (
            <span className="text-xs text-gray-400">
              {sortMode === 'reviewCount'
                ? '正在读取复习次数，暂按字本顺序展示'
                : '正在读取复习次数，复习次数排序暂不可用'}
            </span>
          )}
          {reviewCountResult.status === 'unavailable' && (
            <span role="status" className="text-xs text-amber-700">
              {sortMode === 'reviewCount'
                ? '复习次数暂不可用，当前按字本顺序展示，可拖动调整'
                : '复习次数暂不可用，相关排序已禁用'}
            </span>
          )}
          {sortMode !== 'manual' && reviewCountResult.status === 'ready' && (
            <span className="text-xs text-gray-400">切换回字本顺序可手动拖动排序</span>
          )}
        </div>
      )}

      {/* Character list */}
      {currentWB && displayedChars.length > 0 ? (
        <CharacterList
          characters={displayedChars}
          onReorder={handleReorder}
          onRemove={handleRemove}
          proficiencyMap={proficiencyMap}
          reorderable={canReorder}
          onCharClick={selectedChildId ? char => navigate({ name: 'wordbook', char }) : undefined}
        />
      ) : (
        <div className="text-center py-12 text-gray-400 text-sm">{emptyListMessage}</div>
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
