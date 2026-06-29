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

  // Initialize Google libraries on mount
  useEffect(() => {
    if (!isGoogleConfigured()) {
      // Demo mode — no Google config, allow offline-only use
      setIsLoading(false)
      return
    }

    initGoogleLibraries()
      .then(() => initGapiClient())
      .then(() => {
        initTokenClient()
        if (hasValidToken()) {
          setIsLoggedIn(true)
          getUserProfile()
            .then(setUser)
            .catch(() => setIsLoggedIn(false))
        }
      })
      .catch(console.error)
      .finally(() => setIsLoading(false))
  }, [])

  const login = useCallback(async () => {
    if (!isGoogleConfigured()) {
      // Demo mode — simulate login
      setUser({ name: '演示用户', email: 'demo@example.com', picture: '' })
      setIsLoggedIn(true)
      return
    }

    setIsLoading(true)
    try {
      await requestAccessToken()
      const profile = await getUserProfile()
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
