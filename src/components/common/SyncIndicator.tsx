import { useSync } from '../../state/SyncContext'

const statusConfig: Record<string, { icon: string; color: string; label: string }> = {
  idle: { icon: '☁️', color: 'text-gray-400', label: '' },
  syncing: { icon: '🔄', color: 'text-blue-500', label: '同步中...' },
  online: { icon: '✅', color: 'text-green-500', label: '已同步' },
  offline: { icon: '📴', color: 'text-yellow-500', label: '离线' },
  error: { icon: '⚠️', color: 'text-red-500', label: '同步失败' },
}

export default function SyncIndicator() {
  const { status, syncNow } = useSync()
  const config = statusConfig[status] || statusConfig.idle

  if (status === 'idle' || status === 'online') {
    return (
      <button
        onClick={syncNow}
        className={`text-xs ${config.color} flex items-center gap-1`}
        title="点击同步"
      >
        <span>{config.icon}</span>
      </button>
    )
  }

  return (
    <span className={`text-xs ${config.color} flex items-center gap-1`}>
      <span className={status === 'syncing' ? 'animate-spin inline-block' : ''}>
        {config.icon}
      </span>
      <span className="hidden sm:inline">{config.label}</span>
    </span>
  )
}
