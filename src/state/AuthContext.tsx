import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  type ReactNode,
} from 'react'
import {
  initGoogleLibraries,
  initGapiClient,
  initTokenClient,
  requestAccessToken,
  signOut as googleSignOut,
  getUserProfile,
  hasValidToken,
  isGoogleConfigured,
  restoreToken,
  trySilentLogin,
  saveUserToStorage,
  loadUserFromStorage,
  clearTokenStorage,
  clearUserStorage,
  TOKEN_READY_EVENT,
} from '../data/gapi'

interface UserProfile {
  name: string
  email: string
  picture: string
}

interface AuthState {
  isLoggedIn: boolean
  isLoading: boolean
  user: UserProfile | null
  error: string | null
  login: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<UserProfile | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Initialize Google libraries and restore auth on mount
  useEffect(() => {
    if (!isGoogleConfigured()) {
      // Demo mode — check localStorage for persisted login state
      const storedUser = loadUserFromStorage()
      if (storedUser) {
        setUser(storedUser)
        setIsLoggedIn(true)
      }
      setIsLoading(false)
      return
    }

    initGoogleLibraries()
      .then(() => initGapiClient())
      .then(() => {
        initTokenClient()

        // 5-minute buffer: proactively refresh tokens that expire soon
        const REFRESH_THRESHOLD_MS = 5 * 60 * 1000

        // Step 1: try restoring token from localStorage
        if (restoreToken(REFRESH_THRESHOLD_MS)) {
          setIsLoggedIn(true)
          return getUserProfile()
            .then(profile => {
              setUser(profile)
              saveUserToStorage(profile)
            })
            .catch(() => {
              // Token was invalid — clear login state and stored token
              clearTokenStorage()
              setIsLoggedIn(false)
            })
        }

        // Step 2: no valid stored token — try silent refresh
        // Only for returning users (we have their profile in localStorage).
        // For fresh browsers / cleared data, skip silent login so the user
        // can explicitly choose which Google account to use.
        const storedUser = loadUserFromStorage()
        if (!storedUser) return

        // (won't show popup if user has Google session)
        return trySilentLogin().then(silentToken => {
          if (silentToken) {
            setIsLoggedIn(true)
            return getUserProfile().then(profile => {
              setUser(profile)
              saveUserToStorage(profile)
            })
          }
        })
      })
      .catch(err => {
        // Auth restore failed — user will need to login manually
        setError(err instanceof Error ? err.message : String(err))
        console.error('Auth restore failed:', err)
      })
      .finally(() => setIsLoading(false))
  }, [])

  // 监听 trySilentLogin 延迟回调保存的 token。
  // 当 trySilentLogin 超时后 Google 才回调（用户完成弹窗登录），
  // token 被保存到 localStorage 但 React 状态未更新。
  // 此监听器检测到有效 token 时自动完成登录，无需用户再次点击。
  const isLoggedInRef = useRef(isLoggedIn)
  isLoggedInRef.current = isLoggedIn

  useEffect(() => {
    if (!isGoogleConfigured()) return

    let handling = false

    const handleTokenReady = async () => {
      if (handling || isLoggedInRef.current) return
      if (!hasValidToken()) return
      handling = true
      try {
        const profile = await getUserProfile()
        saveUserToStorage(profile)
        setUser(profile)
        setIsLoggedIn(true)
        setError(null)
      } catch {
        // Token 可能无效 — 忽略，用户可手动登录
      } finally {
        handling = false
      }
    }

    window.addEventListener(TOKEN_READY_EVENT, handleTokenReady)
    return () => window.removeEventListener(TOKEN_READY_EVENT, handleTokenReady)
  }, [])

  const login = useCallback(async () => {
    if (!isGoogleConfigured()) {
      // Demo mode — simulate login and persist state
      const demoUser = { name: '演示用户', email: 'demo@example.com', picture: '' }
      saveUserToStorage(demoUser)
      setUser(demoUser)
      setIsLoggedIn(true)
      return
    }

    setIsLoading(true)
    try {
      // 如果已有有效 token（如 trySilentLogin 延迟回调已保存），
      // 跳过弹窗直接拉取 profile，避免用户看到第二次 OAuth 弹窗
      if (!hasValidToken()) {
        await requestAccessToken()
      }
      const profile = await getUserProfile()
      saveUserToStorage(profile)
      setUser(profile)
      setIsLoggedIn(true)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      console.error('Login failed:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  const logout = useCallback(() => {
    if (isGoogleConfigured()) {
      googleSignOut()
    }
    clearUserStorage()
    setUser(null)
    setIsLoggedIn(false)
    setError(null)
  }, [])

  return (
    <AuthContext.Provider value={{ isLoggedIn, isLoading, user, error, login, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
