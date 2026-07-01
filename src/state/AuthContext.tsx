import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
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
  clearUserStorage,
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
  login: () => Promise<void>
  logout: () => void
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [isLoggedIn, setIsLoggedIn] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [user, setUser] = useState<UserProfile | null>(null)

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

        // Step 1: try restoring token from localStorage
        if (restoreToken()) {
          setIsLoggedIn(true)
          getUserProfile()
            .then((profile) => {
              setUser(profile)
              saveUserToStorage(profile)
            })
            .catch(() => {
              // Token was invalid — clear and fall through to silent refresh
              setIsLoggedIn(false)
            })
        }

        // Step 2: try silent refresh (won't show popup if user has Google session)
        return trySilentLogin()
      })
      .then((silentToken) => {
        if (silentToken) {
          setIsLoggedIn(true)
          return getUserProfile().then((profile) => {
            setUser(profile)
            saveUserToStorage(profile)
          })
        }
      })
      .catch((err) => {
        // Silent refresh failed — user will need to login manually
        console.error('Auth restore failed:', err)
      })
      .finally(() => setIsLoading(false))
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
      await requestAccessToken()
      const profile = await getUserProfile()
      saveUserToStorage(profile)
      setUser(profile)
      setIsLoggedIn(true)
    } catch (err) {
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
  }, [])

  return (
    <AuthContext.Provider value={{ isLoggedIn, isLoading, user, login, logout }}>
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
