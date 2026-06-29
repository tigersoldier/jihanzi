import { useState, useMemo } from 'react'
import { useApp } from '../state/AppContext'
import { getChildStats } from '../core/scheduler'

interface UseChildReturn {
  selectedChildId: string | null
  setSelectedChildId: (id: string) => void
  childList: { id: string; name: string }[]
  currentChild: { id: string; name: string; stats: ReturnType<typeof getChildStats>; wordBookName: string } | null
  hasPrevChild: boolean
  hasNextChild: boolean
  goToPrevChild: () => void
  goToNextChild: () => void
  createChild: (name: string, wordBookId: string) => Promise<void>
  deleteChild: (id: string) => Promise<void>
}

export function useChild(): UseChildReturn {
  const { state, createChild: createChildFn, deleteChild: deleteChildFn } = useApp()

  const childList = useMemo(() =>
    state.children.map(c => ({ id: c.id, name: c.name })),
    [state.children]
  )

  const [selectedChildId, setSelectedChildId] = useState<string | null>(
    () => state.children[0]?.id || null
  )

  const currentIndex = childList.findIndex(c => c.id === selectedChildId)

  const currentChild = useMemo(() => {
    if (!selectedChildId) return null
    const child = state.children.find(c => c.id === selectedChildId)
    if (!child) return null
    const stats = getChildStats(child)
    const wordBook = state.wordBooks.find(w => w.id === child.wordBookId)
    return {
      id: child.id,
      name: child.name,
      stats,
      wordBookName: wordBook?.name || '未关联',
    }
  }, [selectedChildId, state.children, state.wordBooks])

  const hasPrevChild = currentIndex > 0
  const hasNextChild = currentIndex < childList.length - 1

  const goToPrevChild = () => {
    if (hasPrevChild) {
      setSelectedChildId(childList[currentIndex - 1].id)
    }
  }

  const goToNextChild = () => {
    if (hasNextChild) {
      setSelectedChildId(childList[currentIndex + 1].id)
    }
  }

  const createChild = async (name: string, wordBookId: string) => {
    const id = await createChildFn(name, wordBookId)
    setSelectedChildId(id)
  }

  const deleteChild = async (id: string) => {
    await deleteChildFn(id)
    if (selectedChildId === id) {
      setSelectedChildId(childList[0]?.id || null)
    }
  }

  return {
    selectedChildId,
    setSelectedChildId,
    childList,
    currentChild,
    hasPrevChild,
    hasNextChild,
    goToPrevChild,
    goToNextChild,
    createChild,
    deleteChild,
  }
}
