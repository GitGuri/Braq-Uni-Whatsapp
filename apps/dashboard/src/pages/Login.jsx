import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Form, Input, Button, Typography, Alert } from 'antd'
import { LockOutlined, MailOutlined, CheckCircleOutlined } from '@ant-design/icons'
import { useAuth } from '../auth/AuthContext.jsx'

const { Title, Text } = Typography

const FEATURES = [
  'Live WhatsApp consultant inbox',
  'Full order & manufacturing pipeline',
  'AI-powered quotation generation',
  'School uniform catalog management',
  'Client CRM & broadcast messaging',
]

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const onFinish = async ({ email, password }) => {
    setLoading(true)
    setError(null)
    try {
      await login(email, password)
      navigate('/')
    } catch (err) {
      setError(err.response?.data?.error ?? 'Login failed. Please check your credentials and try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      {/* ── Left brand panel ── */}
      <div
        style={{
          flex: '0 0 480px',
          background: 'linear-gradient(145deg, #0a1628 0%, #0d2045 50%, #1a3a6e 100%)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          padding: '60px 52px',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* background decorative circles */}
        <div style={{
          position: 'absolute', top: -80, right: -80, width: 320, height: 320,
          borderRadius: '50%', background: 'rgba(22,119,255,0.08)', pointerEvents: 'none',
        }} />
        <div style={{
          position: 'absolute', bottom: -60, left: -60, width: 240, height: 240,
          borderRadius: '50%', background: 'rgba(22,119,255,0.06)', pointerEvents: 'none',
        }} />

        {/* Wordmark */}
        <div style={{ marginBottom: 48 }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 52, height: 52, borderRadius: 14,
            background: '#1677ff', marginBottom: 20,
          }}>
            <Text style={{ color: '#fff', fontSize: 24, fontWeight: 800, lineHeight: 1 }}>B</Text>
          </div>
          <Title level={2} style={{ color: '#fff', margin: 0, fontWeight: 700, letterSpacing: -0.5 }}>
            Braq Connect™
          </Title>
          <Text style={{ color: '#7ca8e0', fontSize: 15, marginTop: 6, display: 'block' }}>
            Staff Operations Dashboard
          </Text>
        </div>

        {/* Tagline */}
        <Title level={3} style={{ color: '#c8dcf8', fontWeight: 600, lineHeight: 1.35, marginBottom: 32 }}>
          Everything you need to run the business, in one place.
        </Title>

        {/* Feature list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {FEATURES.map((f) => (
            <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <CheckCircleOutlined style={{ color: '#1677ff', fontSize: 16, flexShrink: 0 }} />
              <Text style={{ color: '#a8c4e8', fontSize: 14 }}>{f}</Text>
            </div>
          ))}
        </div>

        {/* Footer */}
        <Text style={{ color: '#3d5a7a', fontSize: 12, marginTop: 'auto', paddingTop: 60 }}>
          © {new Date().getFullYear()} Braq Uni · Confidential
        </Text>
      </div>

      {/* ── Right login panel ── */}
      <div
        style={{
          flex: 1,
          background: '#f8fafc',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '40px 24px',
        }}
      >
        <div style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ marginBottom: 40 }}>
            <Title level={3} style={{ margin: 0, color: '#0d1b2a', fontWeight: 700 }}>
              Sign in
            </Title>
            <Text type="secondary" style={{ fontSize: 15 }}>
              Use your staff account credentials to continue.
            </Text>
          </div>

          {error && (
            <Alert
              type="error"
              message={error}
              showIcon
              closable
              onClose={() => setError(null)}
              style={{ marginBottom: 24, borderRadius: 8 }}
            />
          )}

          <Form layout="vertical" onFinish={onFinish} requiredMark={false} size="large">
            <Form.Item
              name="email"
              label={<Text strong style={{ fontSize: 13 }}>Email address</Text>}
              rules={[
                { required: true, message: 'Please enter your email address' },
                { type: 'email', message: 'Please enter a valid email address' },
              ]}
            >
              <Input
                prefix={<MailOutlined style={{ color: '#bbb' }} />}
                placeholder="you@braquni.com"
                autoComplete="email"
                style={{ borderRadius: 8 }}
              />
            </Form.Item>

            <Form.Item
              name="password"
              label={<Text strong style={{ fontSize: 13 }}>Password</Text>}
              rules={[{ required: true, message: 'Please enter your password' }]}
              style={{ marginBottom: 28 }}
            >
              <Input.Password
                prefix={<LockOutlined style={{ color: '#bbb' }} />}
                placeholder="••••••••"
                autoComplete="current-password"
                style={{ borderRadius: 8 }}
              />
            </Form.Item>

            <Button
              type="primary"
              htmlType="submit"
              loading={loading}
              block
              style={{ borderRadius: 8, height: 46, fontSize: 15, fontWeight: 600 }}
            >
              {loading ? 'Signing in…' : 'Sign in'}
            </Button>
          </Form>

          <Text type="secondary" style={{ display: 'block', textAlign: 'center', marginTop: 32, fontSize: 13 }}>
            Forgot your password? Contact your system administrator.
          </Text>
        </div>
      </div>
    </div>
  )
}
