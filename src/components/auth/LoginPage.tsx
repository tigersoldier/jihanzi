import { useAuth } from '../../state/AuthContext'

export default function LoginPage() {
  const { login, isLoading, error } = useAuth()

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-indigo-50 to-white px-4">
      <div className="max-w-sm w-full text-center">
        {/* Logo */}
        <div className="w-24 h-24 bg-indigo-600 rounded-3xl flex items-center justify-center mx-auto mb-6 shadow-lg">
          <span className="text-5xl font-kai text-white">字</span>
        </div>

        <h1 className="text-3xl font-bold text-gray-900 mb-2 font-kai">记汉字</h1>
        <p className="text-gray-500 mb-8">
          帮助学龄儿童学习和复习汉字的交互式学习工具
        </p>

        {/* Feature highlights */}
        <div className="grid grid-cols-3 gap-4 mb-8 text-center">
          <div>
            <div className="text-2xl mb-1">📝</div>
            <div className="text-xs text-gray-500">高效复习</div>
          </div>
          <div>
            <div className="text-2xl mb-1">🧠</div>
            <div className="text-xs text-gray-500">科学记忆</div>
          </div>
          <div>
            <div className="text-2xl mb-1">☁️</div>
            <div className="text-xs text-gray-500">云端同步</div>
          </div>
        </div>

        {/* Login button */}
        <button
          onClick={login}
          disabled={isLoading}
          className="w-full py-3 px-6 bg-white border-2 border-gray-200 rounded-xl text-gray-700 font-medium hover:border-indigo-300 hover:shadow-md transition-all disabled:opacity-50 flex items-center justify-center gap-3"
        >
          {isLoading ? (
            <span className="inline-block w-5 h-5 border-2 border-gray-300 border-t-indigo-600 rounded-full animate-spin" />
          ) : (
            <svg className="w-5 h-5" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
            </svg>
          )}
          <span>使用 Google 登录</span>
        </button>

        <p className="text-xs text-gray-400 mt-6">
          登录后将数据安全地保存在你的 Google Drive 上
        </p>

        {/* Error display */}
        {error && (
          <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
            {error}
          </div>
        )}
      </div>
    </div>
  )
}
