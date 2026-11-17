import axios from 'axios'

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? '/api',
  timeout: 30_000,
})

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('braq_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// A 401 from the login call itself means "wrong credentials" — let the Login page
// show the message instead of reloading (which would wipe the error).
const isLoginRequest = (config) => /\/staff\/login\/?$/.test(config?.url ?? '')

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // Only a real 401 (bad / expired token) signs out. A 503 means the database is
    // briefly unreachable: the session is still good, so stay signed in.
    if (err.response?.status === 401 && !isLoginRequest(err.config)) {
      localStorage.removeItem('braq_token')
      localStorage.removeItem('braq_staff')
      if (window.location.pathname !== '/login') window.location.href = '/login'
    }
    return Promise.reject(err)
  }
)

export default api
