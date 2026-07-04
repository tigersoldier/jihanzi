import { useState, useCallback } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getPinyin } from '../../utils/chars'
import { PROFICIENCY_DOT, type Proficiency } from '../../hooks/useStats'

interface CharacterListProps {
  characters: string[]
  onReorder: (chars: string[]) => void
  onRemove: (char: string, index: number) => void
  /** Map of character → proficiency level for color coding */
  proficiencyMap?: Record<string, Proficiency>
  /** Called when a character is clicked */
  onCharClick?: (char: string) => void
}

export default function CharacterList({ characters, onReorder, onRemove, proficiencyMap, onCharClick }: CharacterListProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return

    const oldIndex = characters.findIndex((_, i) => `char-${i}` === active.id)
    const newIndex = characters.findIndex((_, i) => `char-${i}` === over.id)

    if (oldIndex === -1 || newIndex === -1) return

    const newChars = arrayMove(characters, oldIndex, newIndex)
    onReorder(newChars)
  }, [characters, onReorder])

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
      <SortableContext items={characters.map((_, i) => `char-${i}`)} strategy={verticalListSortingStrategy}>
        <div className="space-y-1">
          {characters.map((char, index) => (
            <SortableCharItem
              key={`char-${index}`}
              id={`char-${index}`}
              char={char}
              index={index}
              onRemove={() => onRemove(char, index)}
              proficiency={proficiencyMap?.[char]}
              onClick={onCharClick ? () => onCharClick(char) : undefined}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  )
}

function SortableCharItem({
  id,
  char,
  index,
  onRemove,
  proficiency,
  onClick,
}: {
  id: string
  char: string
  index: number
  onRemove: () => void
  proficiency?: Proficiency
  onClick?: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const pinyin = getPinyin(char)

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-3 bg-white rounded-xl border border-gray-100 px-4 py-3 shadow-sm hover:shadow-md transition-shadow ${
        onClick ? 'cursor-pointer' : ''
      }`}
      onClick={onClick}
    >
      {/* Drag handle */}
      <button
        {...attributes}
        {...listeners}
        className="text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing touch-none"
        aria-label="拖动排序"
        onClick={e => e.stopPropagation()}
      >
        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
          <path d="M7 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM13 14a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" />
        </svg>
      </button>

      {/* Proficiency dot */}
      {proficiency && (
        <span className="text-sm flex-shrink-0" title={proficiency}>
          {PROFICIENCY_DOT[proficiency]}
        </span>
      )}

      {/* Number */}
      <span className="text-xs text-gray-400 w-6 text-right tabular-nums">{index + 1}.</span>

      {/* Character */}
      <span className="text-2xl font-kai text-gray-800 flex-1">{char}</span>

      {/* Pinyin */}
      <span className="text-xs text-gray-400 hidden sm:block">{pinyin}</span>

      {/* Remove button */}
      <button
        onClick={e => { e.stopPropagation(); onRemove() }}
        className="text-gray-300 hover:text-red-400 transition-colors p-1"
        aria-label={`删除 ${char}`}
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  )
}
