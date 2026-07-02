import { createContext, useContext, useState } from 'react'
import { login as apiLogin } from '../api/staff.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [staff, setStaff] = useState(() => {
    try {
      const s = localStorage.getItem('braq_staff')
      return s ? JSON.parse(s) : null
    } catch {
      return null
    }
  })

  const login = async (email, password) => {
    const data = await apiLogin(email, password)
    localStorage.setItem('braq_token', data.token)
    localStorage.setItem('braq_staff', JSON.stringify(data.staff))
    setStaff(data.staff)
    return data
  }

  const logout = () => {
    localStorage.removeItem('braq_token')
    localStorage.removeItem('braq_staff')
    setStaff(null)
  }

  return (
    <AuthContext.Provider value={{ staff, login, logout, isAuthenticated: !!staff }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
