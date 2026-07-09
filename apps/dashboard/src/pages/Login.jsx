import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Typography, Alert } from 'antd'
import { MailOutlined, LockOutlined } from '@ant-design/icons'
import { useAuth } from '../auth/AuthContext.jsx'

const { Title, Text } = Typography
const ACCENT = '#c0392b'

/* Each glyph gets its own orbit radius and starting angle.
   The CSS animation rotates the container, counter-rotates the label
   so the text always faces the viewer. */
const GLYPHS = [
  { label: '⚛',  title: 'React',      bg: '#0d2133', color: '#4fc3f7', r: 130, startDeg: 0   },
  { label: 'N',   title: 'Node.js',    bg: '#0d2710', color: '#66bb6a', r: 105, startDeg: 51  },
  { label: 'PG',  title: 'PostgreSQL', bg: '#101730', color: '#7986cb', r: 145, startDeg: 103 },
  { label: 'W',   title: 'WhatsApp',   bg: '#0c2514', color: '#25d366', r: 115, startDeg: 154 },
  { label: 'G',   title: 'Gemini',     bg: '#1e0d30', color: '#b39ddb', r: 135, startDeg: 205 },
  { label: 'S',   title: 'Supabase',   bg: '#0d2222', color: '#26a69a', r: 100, startDeg: 257 },
  { label: 'R',   title: 'Resend',     bg: '#300d0d', color: '#ef9a9a', r: 120, startDeg: 308 },
]

/* Inject keyframes once into a <style> tag */
const KEYFRAMES = `
@keyframes orbit {
  from { transform: rotate(var(--start)) translateX(var(--r)) rotate(calc(-1 * var(--start))); }
  to   { transform: rotate(calc(var(--start) + 360deg)) translateX(var(--r)) rotate(calc(-1 * (var(--start) + 360deg))); }
}
@keyframes float-center {
  0%, 100% { transform: translateY(0px);  }
  50%       { transform: translateY(-8px); }
}

/* Keep inputs dark on hover and focus — Ant Design overrides these */
.braq-login .ant-input-affix-wrapper,
.braq-login .ant-input-affix-wrapper:hover,
.braq-login .ant-input-affix-wrapper:focus,
.braq-login .ant-input-affix-wrapper-focused {
  background: #111 !important;
  border-color: #252525 !important;
}
.braq-login .ant-input-affix-wrapper:hover {
  border-color: #3a3a3a !important;
}
.braq-login .ant-input-affix-wrapper-focused,
.braq-login .ant-input-affix-wrapper:focus-within {
  border-color: #c0392b !important;
  box-shadow: 0 0 0 2px rgba(192,57,43,0.15) !important;
}
.braq-login .ant-input {
  background: #111 !important;
  color: #e8e8e8 !important;
}
.braq-login .ant-input::placeholder {
  color: #444 !important;
}
.braq-login .ant-input-password-icon {
  color: #555 !important;
}
`

const inputStyle = {
  padding: '8px 10px',
  background: '#111',
  borderColor: '#252525',
  color: '#e8e8e8',
  fontSize: 13,
}

export default function Login() {
  const { login }             = useAuth()
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
      setError(err.response?.data?.error ?? 'Login failed. Please check your credentials.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <style>{KEYFRAMES}</style>

      <div style={{
        minHeight: '100vh', background: '#0a0a0a',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '40px',
      }}>
        <div style={{
          display: 'flex', gap: 72, width: '100%', maxWidth: 1100,
          alignItems: 'center',
        }}>

          {/* ══════════════ LEFT: FORM ══════════════ */}
          <div className="braq-login" style={{ flex: '0 0 420px', minWidth: 0 }}>
            {/* Wordmark */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 32 }}>
              <div style={{
                width: 34, height: 34, borderRadius: 9, background: ACCENT,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 800, fontSize: 15, color: '#fff',
              }}>B</div>
              <Text style={{ color: '#e8e8e8', fontSize: 15, fontWeight: 700 }}>Braq Connect™</Text>
            </div>

            <Title level={2} style={{ color: '#f0f0f0', margin: '0 0 6px', fontWeight: 700, letterSpacing: -0.5 }}>
              Sign in
            </Title>
            <Text style={{ color: '#555', fontSize: 14, display: 'block', marginBottom: 28 }}>
              Use your staff credentials to access the dashboard.
            </Text>

            {error && (
              <Alert type="error" message={error} showIcon closable
                onClose={() => setError(null)}
                style={{ marginBottom: 20, borderRadius: 6 }} />
            )}

            <Form layout="vertical" onFinish={onFinish} requiredMark={false}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
                <Form.Item
                  name="email"
                  label={<span style={{ color: '#aaa', fontSize: 12 }}>Email address <span style={{ color: ACCENT }}>*</span></span>}
                  rules={[{ required: true, message: 'Required' }, { type: 'email', message: 'Invalid email' }]}
                  style={{ marginBottom: 0 }}
                >
                  <Input
                    prefix={<MailOutlined style={{ color: '#3a3a3a', fontSize: 13 }} />}
                    placeholder="your@email.com"
                    autoComplete="email"
                    style={inputStyle}
                  />
                </Form.Item>

                <Form.Item
                  name="password"
                  label={<span style={{ color: '#aaa', fontSize: 12 }}>Password <span style={{ color: ACCENT }}>*</span></span>}
                  rules={[{ required: true, message: 'Required' }]}
                  style={{ marginBottom: 0 }}
                >
                  <Input.Password
                    prefix={<LockOutlined style={{ color: '#3a3a3a', fontSize: 13 }} />}
                    placeholder="••••••••"
                    autoComplete="current-password"
                    style={inputStyle}
                  />
                </Form.Item>
              </div>

              <button
                type="submit"
                disabled={loading}
                style={{
                  width: '100%', padding: '10px 12px', borderRadius: 6,
                  background: loading ? '#7a2318' : ACCENT,
                  color: '#fff', border: 'none', fontSize: 14, fontWeight: 600,
                  cursor: loading ? 'not-allowed' : 'pointer',
                  transition: 'background 0.15s', fontFamily: 'inherit',
                }}
                onMouseOver={e => !loading && (e.currentTarget.style.background = '#a93226')}
                onMouseOut={e => !loading && (e.currentTarget.style.background = ACCENT)}
              >
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </Form>

            <Text style={{ display: 'block', textAlign: 'center', fontSize: 12, color: '#444', marginTop: 20 }}>
              Need access?{' '}
              <span style={{ color: ACCENT, cursor: 'pointer' }}>Contact your administrator</span>
            </Text>
          </div>

          {/* ══════════════ RIGHT: ORBITAL ANIMATION ══════════════ */}
          <div style={{
            flex: '0 0 420px',
            background: '#111',
            border: '1px solid #1e1e1e',
            borderRadius: 16,
            padding: '52px 44px',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', textAlign: 'center',
            minHeight: 500, position: 'relative', overflow: 'hidden',
          }}>
            {/* Subtle radial glow behind the orbits */}
            <div style={{
              position: 'absolute', top: '50%', left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 320, height: 320, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(192,57,43,0.08) 0%, transparent 70%)',
              pointerEvents: 'none',
            }} />

            {/* Orbit rings (decorative) */}
            {[100, 120, 140].map(r => (
              <div key={r} style={{
                position: 'absolute', top: '50%', left: '50%',
                width: r * 2, height: r * 2,
                marginTop: -r, marginLeft: -r,
                borderRadius: '50%',
                border: '1px solid rgba(255,255,255,0.03)',
                pointerEvents: 'none',
              }} />
            ))}

            {/* Orbital glyph cluster */}
            <div style={{ position: 'relative', width: 300, height: 300, marginBottom: 32 }}>
              {/* Centre "B" logo */}
              <div style={{
                position: 'absolute', top: '50%', left: '50%',
                transform: 'translate(-50%, -50%)',
                width: 52, height: 52, borderRadius: 14,
                background: ACCENT,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 900, fontSize: 22, color: '#fff',
                boxShadow: `0 0 24px rgba(192,57,43,0.4)`,
                animation: 'float-center 3s ease-in-out infinite',
                zIndex: 2,
              }}>B</div>

              {/* Orbiting glyphs */}
              {GLYPHS.map((g, i) => (
                <div
                  key={g.title}
                  title={g.title}
                  style={{
                    position: 'absolute',
                    top: '50%', left: '50%',
                    marginTop: -24, marginLeft: -24,
                    /* CSS custom props consumed by the keyframe */
                    '--start': `${g.startDeg}deg`,
                    '--r':     `${g.r}px`,
                    width: 48, height: 48, borderRadius: '50%',
                    background: g.bg,
                    border: `1px solid rgba(255,255,255,0.08)`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700, color: g.color,
                    boxShadow: `0 0 12px ${g.color}22`,
                    animation: `orbit ${18 + i * 3}s linear infinite`,
                    transformOrigin: '24px 24px',
                  }}
                >
                  {g.label}
                </div>
              ))}
            </div>

            <Title level={3} style={{ color: '#f0f0f0', margin: '0 0 14px', fontWeight: 700, letterSpacing: -0.3 }}>
              Built for Braq Uni
            </Title>
            <Text style={{ color: '#4a4a4a', fontSize: 14, lineHeight: 1.65, maxWidth: 300 }}>
              A unified operations platform connecting your WhatsApp commerce, manufacturing pipeline, and client management in one place.
            </Text>
          </div>

        </div>
      </div>
    </>
  )
}
