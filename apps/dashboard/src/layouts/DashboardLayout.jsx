import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Avatar, Typography } from 'antd'
import {
  MenuOutlined,
  DashboardOutlined, MessageOutlined, FileTextOutlined, ShoppingCartOutlined,
  CustomerServiceOutlined, TeamOutlined, AppstoreOutlined, SettingOutlined,
  UserOutlined,
} from '@ant-design/icons'
import { useAuth } from '../auth/AuthContext.jsx'

const { Text } = Typography

const ACCENT    = '#c0392b'
const NAVBAR_H  = 60
const SIDEBAR_W = 240
const SIDEBAR_SM = 68

const NAV = [
  { key: '/',           icon: <DashboardOutlined />,       label: 'Dashboard' },
  { key: '/inbox',      icon: <MessageOutlined />,         label: 'Inbox' },
  { divider: true },
  { key: '/quotations', icon: <FileTextOutlined />,     label: 'Quotations' },
  { key: '/orders',     icon: <ShoppingCartOutlined />, label: 'Orders' },
  { divider: true },
  { key: '/tickets',    icon: <CustomerServiceOutlined />, label: 'Tickets' },
  { key: '/clients',    icon: <TeamOutlined />,            label: 'Clients' },
  { divider: true },
  { key: '/products',   icon: <AppstoreOutlined />,        label: 'Products' },
  { key: '/staff',      icon: <SettingOutlined />,         label: 'Staff' },
]

export default function DashboardLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const { staff, logout } = useAuth()
  const navigate          = useNavigate()
  const location          = useLocation()

  const isActive = (key) =>
    key === '/' ? location.pathname === '/' : location.pathname.startsWith(key)

  const sW = collapsed ? SIDEBAR_SM : SIDEBAR_W

  return (
    <div style={{ background: '#0a0a0a', minHeight: '100vh' }}>

      {/* ════════════════ NAVBAR ════════════════ */}
      <header style={{
        position: 'fixed', top: 0, left: 0, right: 0, height: NAVBAR_H, zIndex: 200,
        background: '#0d0d0d', borderBottom: '1px solid #1a1a1a',
        display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px',
      }}>
        {/* Hamburger */}
        <button className="braq-icon-btn" onClick={() => setCollapsed(c => !c)}>
          <MenuOutlined />
        </button>

        {/* Brand */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <div style={{
            width: 28, height: 28, borderRadius: 7, background: ACCENT,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontWeight: 800, fontSize: 13, color: '#fff',
          }}>B</div>
          <span style={{ color: '#e8e8e8', fontSize: 14, fontWeight: 700, letterSpacing: 0.2 }}>
            Braq Connect
          </span>
        </div>

        {/* Spacer */}
        <div style={{ flex: 1 }} />

        {/* Right: avatar + logout only */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Avatar icon={<UserOutlined />} size={30}
            style={{ background: '#2a2a2a', cursor: 'pointer', flexShrink: 0 }} />
          <Text style={{ color: '#555', fontSize: 12 }}>
            {staff?.name ?? 'Staff'}
          </Text>
          <button
            style={{
              background: 'none', border: '1px solid #252525', cursor: 'pointer',
              color: '#666', fontSize: 12, padding: '4px 10px',
              borderRadius: 5, transition: 'all 0.15s', fontFamily: 'inherit',
            }}
            onMouseOver={e => { e.currentTarget.style.color = ACCENT; e.currentTarget.style.borderColor = ACCENT }}
            onMouseOut={e => { e.currentTarget.style.color = '#666'; e.currentTarget.style.borderColor = '#252525' }}
            onClick={() => { logout(); navigate('/login') }}
          >
            Logout
          </button>
        </div>
      </header>

      {/* ════════════════ BODY ════════════════ */}
      <div style={{ display: 'flex', paddingTop: NAVBAR_H }}>

        {/* ════════════════ SIDEBAR ════════════════ */}
        <aside style={{
          position: 'fixed', left: 0, top: NAVBAR_H, bottom: 0,
          width: sW,
          background: '#0d0d0d', borderRight: '1px solid #1a1a1a',
          display: 'flex', flexDirection: 'column',
          overflowY: 'auto', overflowX: 'hidden',
          transition: 'width 0.2s ease', zIndex: 100,
        }}>
          <nav style={{ flex: 1, paddingTop: 8, paddingBottom: 12 }}>
            {NAV.map((item, idx) => {
              if (item.divider) return (
                <div key={idx} style={{ height: 1, background: '#1a1a1a', margin: '6px 16px' }} />
              )

              const active = isActive(item.key)

              return (
                <div
                  key={item.key}
                  className={`braq-nav-item${active ? ' active' : ''}`}
                  onClick={() => navigate(item.key)}
                  title={collapsed ? item.label : undefined}
                >
                  <span style={{ fontSize: 15, flexShrink: 0, color: 'inherit' }}>
                    {item.icon}
                  </span>
                  {!collapsed && (
                    <span style={{ flex: 1, color: 'inherit', fontWeight: active ? 600 : 400 }}>
                      {item.label}
                    </span>
                  )}
                </div>
              )
            })}
          </nav>
        </aside>

        {/* ════════════════ CONTENT ════════════════ */}
        <main style={{
          marginLeft: sW,
          flex: 1,
          padding: 24,
          minHeight: `calc(100vh - ${NAVBAR_H}px)`,
          transition: 'margin-left 0.2s ease',
        }}>
          <Outlet />
        </main>
      </div>
    </div>
  )
}
