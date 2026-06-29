import { useState } from 'react'
import { AuthProvider, useAuth } from './state/AuthContext'
import { AppProvider, useApp } from './state/AppContext'
import { SyncProvider } from './state/SyncContext'
import Layout from './components/layout/Layout'
import LoginPage from './components/auth/LoginPage'
import TodayPage from './components/today/TodayPage'
import ChildPage from './components/child/ChildPage'
import WordBookPage from './components/wordbook/WordBookPage'
import SettingsPage from './components/settings/SettingsPage'

export type Tab = 'today' | 'child' | 'wordbook'

function AppContent() {
  const { isLoggedIn, isLoading } = useAuth()
  const [activeTab, setActiveTab] = useState<Tab>('today')
  const [showSettings, setShowSettings] = useState(false)

  // Show loading state
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-indigo-200 border-t-indigo-600 rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">加载中...</p>
        </div>
      </div>
    )
  }

  // Not logged in — show login page
  if (!isLoggedIn) {
    return <LoginPage />
  }

  // Settings overlay
  if (showSettings) {
    return <SettingsPage onClose={() => setShowSettings(false)} />
  }

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={setActiveTab}
      onSettingsClick={() => setShowSettings(true)}
    >
      {activeTab === 'today' && <TodayPage />}
      {activeTab === 'child' && <ChildPage />}
      {activeTab === 'wordbook' && <WordBookPage />}
    </Layout>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppProvider>
        <SyncProvider>
          <AppContent />
        </SyncProvider>
      </AppProvider>
    </AuthProvider>
  )
}
