import { useState, useMemo, useCallback } from 'react'
import { useApp } from '../state/AppContext'
import { isChineseChar, ValidationError } from '../utils/chars'

interface UseWordBookReturn {
  selectedWBId: string | null
  setSelectedWBId: (id: string) => void
  wbList: { id: string; name: string; count: number }[]
  currentWB: { id: string; name: string; characters: string[] } | null
  addCharacter: (char: string) => Promise<void>
  removeCharacter: (char: string, index: number) => Promise<void>
  reorderCharacters: (chars: string[]) => Promise<void>
  createWB: (name: string, chars?: string[]) => Promise<void>
  deleteWB: (id: string) => Promise<void>
  updateWBName: (id: string, name: string) => Promise<void>
}

export function useWordBook(): UseWordBookReturn {
  const {
    state,
    addCharacter: addCharFn,
    removeCharacter: removeCharFn,
    reorderCharacters: reorderFn,
    createWordBook,
    deleteWordBook,
    updateWordBook,
  } = useApp()

  const [selectedWBId, setSelectedWBId] = useState<string | null>(
    () => state.wordBooks[0]?.id || null
  )

  const wbList = useMemo(() =>
    state.wordBooks.map(w => ({ id: w.id, name: w.name, count: w.characters.length })),
    [state.wordBooks]
  )

  const currentWB = useMemo(() => {
    if (!selectedWBId) return null
    const wb = state.wordBooks.find(w => w.id === selectedWBId)
    return wb || null
  }, [selectedWBId, state.wordBooks])

  const addCharacter = useCallback(async (char: string) => {
    const trimmed = char.trim()
    if (!selectedWBId || !trimmed) return
    // Add each character separately, skipping non-Chinese characters
    // (commas, spaces, punctuation) and duplicates.
    for (const c of trimmed) {
      if (!isChineseChar(c)) continue
      try {
        await addCharFn(selectedWBId, c)
      } catch (err) {
        if (err instanceof ValidationError) {
          // Skip duplicates or other validation failures; continue with
          // remaining characters so one bad input doesn't block the rest.
          continue
        }
        // System errors (IndexedDB, network, …) must propagate so the
        // caller can surface them to the user.
        console.error('addCharacter failed:', err)
        throw err
      }
    }
  }, [selectedWBId, addCharFn])

  const removeCharacter = useCallback(async (char: string, index: number) => {
    if (!selectedWBId) return
    await removeCharFn(selectedWBId, char, index)
  }, [selectedWBId, removeCharFn])

  const reorderCharacters = useCallback(async (chars: string[]) => {
    if (!selectedWBId) return
    await reorderFn(selectedWBId, chars)
  }, [selectedWBId, reorderFn])

  const createWB = useCallback(async (name: string, chars?: string[]) => {
    const id = await createWordBook(name, chars)
    setSelectedWBId(id)
  }, [createWordBook])

  const deleteWB = useCallback(async (id: string) => {
    await deleteWordBook(id)
    if (selectedWBId === id) {
      setSelectedWBId(state.wordBooks[0]?.id || null)
    }
  }, [deleteWordBook, selectedWBId, state.wordBooks])

  const updateWBName = useCallback(async (id: string, name: string) => {
    await updateWordBook(id, name)
  }, [updateWordBook])

  return {
    selectedWBId,
    setSelectedWBId,
    wbList,
    currentWB,
    addCharacter,
    removeCharacter,
    reorderCharacters,
    createWB,
    deleteWB,
    updateWBName,
  }
}
