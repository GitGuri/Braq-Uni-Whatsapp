import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Alert, Button } from 'antd'
import { SunOutlined, MoonOutlined } from '@ant-design/icons'
import { useAuth } from '../auth/AuthContext.jsx'
import { useTheme } from '../theme/ThemeContext.jsx'
import { errorMessage } from '../utils/errorMessage.js'
import LoginScene from '../components/LoginScene.jsx'

const CSS = `
.braq-login-page {
  position: relative;
  min-height: 100vh;
  background: #18181D;
  display: flex; align-items: center; justify-content: center;
  padding: 24px 16px calc(max(9vh, 56px) + 24px);
}
.braq-login-card {
  position: relative; z-index: 1;
  width: min(420px, 100%);
  padding: 36px 34px 30px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.45);
  animation: braq-card-in 0.5s cubic-bezier(0.22, 1, 0.36, 1) 0.1s both;
}
@keyframes braq-card-in { from { opacity: 0; transform: translateY(12px) scale(0.98); } to { opacity: 1; transform: none; } }
/* The card's red stitched edge sews itself once on load */
.braq-login-stitch { position: absolute; inset: 8px; width: calc(100% - 16px); height: calc(100% - 16px); pointer-events: none; overflow: visible; }
.braq-login-stitch .sew { animation: braq-sew 1.6s cubic-bezier(0.65, 0, 0.35, 1) 0.4s both; }
@keyframes braq-sew { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
.braq-login-brand { display: flex; align-items: center; gap: 14px; margin-bottom: 26px; }
.braq-login-brand img { width: 56px; height: 56px; border-radius: 50%; background: #0b0b0b; flex-shrink: 0; }
.braq-login-brand-name { font-size: 22px; font-stretch: 122%; font-weight: 700; line-height: 1.05; color: var(--ink); }
.braq-login-brand-sub { font-size: 13px; color: var(--ink-3); margin-top: 3px; }
.braq-login-card h2 { margin: 0 0 4px; font-size: 22px; font-weight: 650; color: var(--ink); }
.braq-login-card .lede { margin: 0 0 22px; color: var(--ink-2); }
.braq-login-foot { margin-top: 18px; font-size: 13px; color: var(--ink-3); }
.braq-login-theme {
  position: fixed; top: 16px; right: 16px; z-index: 2;
  background: rgba(255,255,255,0.06); color: #D8D9DE; border-color: rgba(255,255,255,0.12);
}
.braq-login-theme:hover { background: rgba(255,255,255,0.12); color: #fff; border-color: rgba(255,255,255,0.2); }
@media (max-width: 760px) {
  .braq-login-page { align-items: flex-start; padding: 64px 14px calc(max(9vh, 56px) + min(42vw, 30vh) + 12px); }
  .braq-login-card { padding: 28px 22px 24px; }
}
`

export default function Login() {
  const { login }             = useAuth()
  const { mode, toggle }      = useTheme()
  const navigate              = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const onFinish = async ({ email, password }) => {
    setLoading(true)
    setError(null)
    try {
      await login(email, password)
      navigate('/')
    } catch (err) {
      setError(errorMessage(err, 'Sign-in failed. Check your email and password.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="braq-login-page">
      <style>{CSS}</style>
      <LoginScene />

      <button
        type="button"
        className="braq-icon-btn braq-login-theme"
        onClick={toggle}
        aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      >
        {mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
      </button>

      <main className="braq-login-card">
        <svg className="braq-login-stitch" aria-hidden="true">
          <defs>
            <mask id="braq-sew-mask">
              <rect className="sew" x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="14"
                fill="none" stroke="#fff" strokeWidth="6" pathLength="1" strokeDasharray="1" />
            </mask>
          </defs>
          <rect x="1" y="1" width="calc(100% - 2px)" height="calc(100% - 2px)" rx="14"
            fill="none" stroke="#C8102E" strokeWidth="1.6" strokeDasharray="7 6" mask="url(#braq-sew-mask)" opacity="0.85" />
        </svg>

        <div className="braq-login-brand">
          <img src="/logo.png" alt="Braq Uni — Uniform Specialists" />
          <div>
            <div className="braq-login-brand-name">Braq Connect</div>
            <div className="braq-login-brand-sub">Braq Uni staff</div>
          </div>
        </div>

        <h2>Welcome back</h2>
        <p className="lede">Sign in with your staff email.</p>

        {error && (
          <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} style={{ marginBottom: 20 }} />
        )}

        <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
          <Form.Item
            name="email"
            label="Email"
            rules={[{ required: true, message: 'Enter your email' }, { type: 'email', message: 'Enter a valid email address' }]}
          >
            <Input placeholder="name@braquni.com" autoComplete="email" inputMode="email" />
          </Form.Item>

          <Form.Item
            name="password"
            label="Password"
            rules={[
              { required: true, message: 'Enter your password' },
              { min: 6, message: 'Password must be at least 6 characters' },
            ]}
            style={{ marginBottom: 26 }}
          >
            <Input.Password autoComplete="current-password" />
          </Form.Item>

          <Button type="primary" htmlType="submit" block loading={loading} style={{ height: 46 }}>
            {loading ? 'Signing in' : 'Sign in'}
          </Button>
        </Form>

        <div className="braq-login-foot">No account yet? An admin can add you under Staff.</div>
      </main>
    </div>
  )
}
