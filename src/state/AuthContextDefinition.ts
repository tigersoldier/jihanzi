import { createContext, useContext } from 'react'

export interface UserProfile {
  name: string
  email: string
  picture: string
}

export interface AuthState {
  isLoggedIn: boolean
  isLoading: boolean
  user: UserProfile | null
  error: string | null
  login: () => Promise<void>
  logout: () => void
}

export const AuthContext = createContext<AuthState | null>(null)

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
