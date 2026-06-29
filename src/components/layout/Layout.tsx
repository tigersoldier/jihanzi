import { type ReactNode } from 'react'
import TopBar from './TopBar'
import BottomNav from './BottomNav'
import type { Tab } from '../../App'

interface LayoutProps {
  children: ReactNode
  activeTab: Tab
  onTabChange: (tab: Tab) => void
  onSettingsClick: () => void
}

export default function Layout({ children, activeTab, onTabChange, onSettingsClick }: LayoutProps) {
  return (
    <div className="flex min-h-screen flex-col bg-gray-50">
      <TopBar onSettingsClick={onSettingsClick} />
      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-4 pb-20">
        {children}
      </main>
      <BottomNav activeTab={activeTab} onTabChange={onTabChange} />
    </div>
  )
}
