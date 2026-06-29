interface WordBookSwitcherProps {
  wbList: { id: string; name: string; count: number }[]
  selectedWBId: string | null
  onSelect: (id: string) => void
}

export default function WordBookSwitcher({ wbList, selectedWBId, onSelect }: WordBookSwitcherProps) {
  if (wbList.length <= 1) return null

  return (
    <select
      value={selectedWBId || ''}
      onChange={e => onSelect(e.target.value)}
      className="w-full px-4 py-2 border border-gray-200 rounded-lg text-sm bg-white focus:outline-none focus:border-indigo-300"
    >
      {wbList.map(wb => (
        <option key={wb.id} value={wb.id}>
          {wb.name}（{wb.count} 字）
        </option>
      ))}
    </select>
  )
}
