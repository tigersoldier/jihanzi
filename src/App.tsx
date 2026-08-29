import { useRef } from 'react'
import { AuthProvider, useAuth } from './state/AuthContext'
import { AppProvider } from './state/AppContext'
import { SyncProvider } from './state/SyncContext'
import Layout from './components/layout/Layout'
import LoginPage from './components/auth/LoginPage'
import ProgressPage from './components/today/ProgressPage'
import ChildPage from './components/child/ChildPage'
import WordBookPage from './components/wordbook/WordBookPage'
import SettingsPage from './components/settings/SettingsPage'
import { useRoute } from './hooks/useRoute'
import type { Route } from './router'

export type Tab = 'progress' | 'child' | 'wordbook'

const TAB_NAMES: readonly Tab[] = ['progress', 'child', 'wordbook']

function AppContent() {
  const { isLoggedIn, isLoading } = useAuth()
  const { route, navigate, goBack } = useRoute()

  // 打开设置前记住当前页面，作为设置关闭按钮无历史可退时的回退目标
  const prevRouteRef = useRef<Route>({ name: 'progress' })

  // 标签页与设置页均由 URL 驱动：#/progress、#/child、#/wordbook、#/settings
  const activeTab: Tab = TAB_NAMES.includes(route.name as Tab) ? (route.name as Tab) : 'progress'
  const showSettings = route.name === 'settings'

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

  // Settings overlay（作为独立路由 #/settings push 进入）
  if (showSettings) {
    return <SettingsPage onClose={() => goBack(prevRouteRef.current)} />
  }

  return (
    <Layout
      activeTab={activeTab}
      onTabChange={tab => navigate({ name: tab })}
      onSettingsClick={() => {
        prevRouteRef.current = route
        navigate({ name: 'settings' })
      }}
    >
      {activeTab === 'progress' && <ProgressPage />}
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
