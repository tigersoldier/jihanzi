import type { Tab } from '../../App'

interface BottomNavProps {
  activeTab: Tab
  onTabChange: (tab: Tab) => void
}

const tabs: { key: Tab; label: string; icon: string }[] = [
  { key: 'today', label: '今天', icon: '📅' },
  { key: 'child', label: '孩子', icon: '👶' },
  { key: 'wordbook', label: '生字本', icon: '📚' },
]

export default function BottomNav({ activeTab, onTabChange }: BottomNavProps) {
  return (
    <nav className="sticky bottom-0 z-30 bg-white/80 backdrop-blur-md border-t border-gray-200 safe-area-bottom">
      <div className="max-w-2xl mx-auto flex">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => onTabChange(tab.key)}
            className={`flex-1 flex flex-col items-center py-2 text-xs font-medium transition-colors ${
              activeTab === tab.key
                ? 'text-indigo-600'
                : 'text-gray-400 hover:text-gray-600'
            }`}
          >
            <span className="text-xl mb-0.5">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}
