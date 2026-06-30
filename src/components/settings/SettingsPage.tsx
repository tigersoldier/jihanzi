import { useAuth } from '../../state/AuthContext'
import { useApp } from '../../state/AppContext'
import { useSync } from '../../state/SyncContext'

interface SettingsPageProps {
  onClose: () => void
}

export default function SettingsPage({ onClose }: SettingsPageProps) {
  const { user, logout } = useAuth()
  const { state, updateSettings, getLogEntries, bulkImport } = useApp()
  const { status, syncNow } = useSync()

  const handleExport = async () => {
    try {
      const logs = await getLogEntries()
      const data = {
        version: '0.1.0',
        exportedAt: new Date().toISOString(),
        settings: state.settings,
        children: state.children,
        wordBooks: state.wordBooks,
        logs,
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `jihanzi-backup-${new Date().toISOString().split('T')[0]}.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Export failed:', err)
      alert('导出失败')
    }
  }

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,.jsonl'
    input.multiple = true
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files
      if (!files || files.length === 0) return

      try {
        // Read all selected files and identify snapshot vs log
        let snapshotData: { timestamp: number; state: any } | null = null
        const logEntries: any[] = []

        for (const file of Array.from(files)) {
          const text = await file.text()
          const isJsonl = file.name.endsWith('.jsonl')

          if (isJsonl) {
            // Parse JSONL — each line is a JSON object
            text.split('\n').filter(l => l.trim()).forEach(line => {
              try {
                logEntries.push(JSON.parse(line))
              } catch { /* skip invalid lines */ }
            })
          } else {
            // Try parsing as snapshot (has `state` field) or as log array
            try {
              const parsed = JSON.parse(text)
              if (parsed.state && parsed.timestamp !== undefined) {
                snapshotData = parsed
              } else if (Array.isArray(parsed)) {
                logEntries.push(...parsed)
              } else {
                // Might be the old monolithic backup format
                if (parsed.children || parsed.wordBooks) {
                  snapshotData = {
                    timestamp: Date.now(),
                    state: {
                      children: parsed.children || [],
                      wordBooks: parsed.wordBooks || [],
                      settings: parsed.settings || { dailyReviewLimit: 30, dailyNewChars: 5, maxRounds: 3 },
                    },
                  }
                  if (parsed.logs) logEntries.push(...parsed.logs)
                }
              }
            } catch { /* skip */ }
          }
        }

        if (!snapshotData) {
          alert('未找到 snapshot 文件（需包含 state 和 timestamp 字段）')
          return
        }

        await bulkImport(snapshotData as any, logEntries)
        alert(`导入成功：${snapshotData.state.children?.length || 0} 个孩子，${snapshotData.state.wordBooks?.length || 0} 个生字本，${logEntries.length} 条日志`)
      } catch (err) {
        console.error('Import failed:', err)
        alert('导入失败：' + (err as Error).message)
      }
    }
    input.click()
  }

  const syncStatusLabels: Record<string, string> = {
    idle: '空闲',
    syncing: '同步中...',
    online: '已连线',
    offline: '离线',
    error: '同步失败',
  }

  return (
    <div className="fixed inset-0 z-50 bg-gray-50 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-4 py-4">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold text-gray-800">⚙ 设置</h1>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-200 transition-colors text-gray-500"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="space-y-4">
          {/* User info */}
          {user && (
            <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-4 flex items-center gap-3">
              {user.picture && (
                <img src={user.picture} alt="" className="w-10 h-10 rounded-full" />
              )}
              <div>
                <p className="font-medium text-gray-800 text-sm">{user.name}</p>
                <p className="text-xs text-gray-400">{user.email}</p>
              </div>
              <div className="flex-1" />
              <button
                onClick={logout}
                className="text-xs text-red-500 hover:text-red-600 font-medium"
              >
                退出登录
              </button>
            </div>
          )}

          {/* Daily limits */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <h2 className="font-bold text-gray-800 mb-4">每日复习设置</h2>

            <div className="space-y-4">
              <SettingRow
                label="每日复习上限"
                value={state.settings.dailyReviewLimit}
                onChange={(v) => updateSettings({ dailyReviewLimit: v })}
                options={[10, 20, 25, 30, 35, 40]}
              />
              <SettingRow
                label="每次新字数量"
                value={state.settings.dailyNewChars}
                onChange={(v) => updateSettings({ dailyNewChars: v })}
                options={[3, 5, 8, 10]}
              />
            </div>
          </div>

          {/* Data management */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
            <h2 className="font-bold text-gray-800 mb-4">数据管理</h2>

            <div className="space-y-2">
              <button
                onClick={handleExport}
                className="w-full py-3 px-4 bg-gray-50 hover:bg-gray-100 rounded-xl text-sm font-medium text-gray-700 transition-colors text-left"
              >
                📤 导出数据
              </button>
              <button
                onClick={handleImport}
                className="w-full py-3 px-4 bg-gray-50 hover:bg-gray-100 rounded-xl text-sm font-medium text-gray-700 transition-colors text-left"
              >
                📥 导入数据
              </button>
            </div>

            <div className="mt-4 p-3 bg-indigo-50 rounded-xl text-xs text-indigo-700 flex items-start gap-2">
              <span>ℹ</span>
              <span>
                数据已自动保存在你的 Google Drive 上，随时可以恢复。同步状态：{syncStatusLabels[status] || status}
                <button onClick={syncNow} className="ml-2 underline hover:text-indigo-800">立即同步</button>
              </span>
            </div>
          </div>

          {/* About */}
          <div className="text-center text-xs text-gray-400 py-4">
            记汉字 v0.1.0
          </div>
        </div>
      </div>
    </div>
  )
}

function SettingRow({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  options: number[]
}) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-600">{label}</span>
      <select
        value={value}
        onChange={e => onChange(Number(e.target.value))}
        className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm bg-white"
      >
        {options.map(opt => (
          <option key={opt} value={opt}>{opt} 字</option>
        ))}
      </select>
    </div>
  )
}
