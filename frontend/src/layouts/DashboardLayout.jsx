import { useState, useEffect, Suspense } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Drawer, Dropdown, Spin } from 'antd'
import {
  MenuOutlined, MenuFoldOutlined, MenuUnfoldOutlined,
  DashboardOutlined, MessageOutlined,
  CustomerServiceOutlined, TeamOutlined, AppstoreOutlined, SettingOutlined,
  NotificationOutlined, BarChartOutlined, LogoutOutlined,
  FileDoneOutlined, BookOutlined, SunOutlined, MoonOutlined, ProjectOutlined,
} from '@ant-design/icons'
import { useAuth } from '../auth/AuthContext.jsx'
import { useTheme } from '../theme/ThemeContext.jsx'
import { getUnreadCount } from '../api/conversations.js'
import { useCan } from '../lib/useCan.js'
import { qk } from '../lib/queryKeys.js'

const SIDEBAR_W  = 248
const SIDEBAR_SM = 68
const MOBILE_QUERY = '(max-width: 767.98px)'

function useIsMobile() {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(MOBILE_QUERY).matches
  const [mobile, setMobile] = useState(get)
  useEffect(() => {
    const mq = window.matchMedia?.(MOBILE_QUERY)
    if (!mq) return undefined
    const onChange = () => setMobile(mq.matches)
    onChange()
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [])
  return mobile
}

function readCollapsed() {
  try { return localStorage.getItem('braq_sidebar') === 'collapsed' } catch { return false }
}

// Grouped by the work staff are doing, not by data type. `perm` hides an item
// from staff without that permission (from GET /api/meta via useCan).
const NAV = [
  { items: [{ key: '/', icon: <DashboardOutlined />, label: 'Dashboard' }] },
  // Jobs is the one place for quotes and orders (the board has Quotes / Orders views).
  { label: 'Sales & production', items: [
    { key: '/jobs',            icon: <ProjectOutlined />,      label: 'Jobs' },
  ] },
  { label: 'Customers', items: [
    { key: '/inbox',      icon: <MessageOutlined />,         label: 'Inbox', count: 'waiting' },
    { key: '/clients',    icon: <TeamOutlined />,            label: 'Clients' },
    { key: '/tickets',    icon: <CustomerServiceOutlined />, label: 'Tickets' },
    { key: '/broadcasts', icon: <NotificationOutlined />,    label: 'Broadcasts' },
  ] },
  { label: 'Catalogue', items: [
    { key: '/products',       icon: <AppstoreOutlined />, label: 'Products' },
    { key: '/school-catalog', icon: <BookOutlined />,     label: 'School catalog' },
  ] },
  { label: 'Admin', items: [
    { key: '/purchase-orders', icon: <FileDoneOutlined />, label: 'Purchase orders', perm: 'po.create' },
    { key: '/staff',     icon: <SettingOutlined />,  label: 'Staff', perm: 'staff.manage' },
    { key: '/analytics', icon: <BarChartOutlined />, label: 'Analytics', perm: 'analytics.view' },
  ] },
]

export default function DashboardLayout() {
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [scrolled, setScrolled] = useState(false)
  const isMobile          = useIsMobile()
  const { staff, logout } = useAuth()
  const { mode, toggle }  = useTheme()
  const navigate          = useNavigate()
  const location          = useLocation()
  const can               = useCan()
  const nav = NAV.map((g) => ({ ...g, items: g.items.filter((i) => !i.perm || can(i.perm)) })).filter((g) => g.items.length)

  const { data: unread } = useQuery({
    queryKey: qk.unread,
    queryFn: getUnreadCount,
    refetchInterval: 30_000,
  })
  const counts = { waiting: Number(unread?.waiting ?? 0) }

  const isActive = (key) =>
    key === '/' ? location.pathname === '/' : location.pathname === key || location.pathname.startsWith(key + '/')

  const sidebarW = isMobile ? 0 : collapsed ? SIDEBAR_SM : SIDEBAR_W

  useEffect(() => { setDrawerOpen(false) }, [location.pathname, isMobile])
  useEffect(() => { try { localStorage.setItem('braq_sidebar', collapsed ? 'collapsed' : 'open') } catch { /* not remembered */ } }, [collapsed])
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  const renderNav = (narrow) => (
    <>
      <div className="braq-brand" style={narrow ? { justifyContent: 'center', padding: '18px 0 16px' } : undefined}>
        <img src="/logo.png" alt="Braq Uni" />
        {!narrow && (
          <div>
            <div className="braq-brand-name">Braq Connect</div>
            <div className="braq-brand-sub">Braq Uni staff</div>
          </div>
        )}
      </div>

      <nav className="braq-nav" aria-label="Main">
        {nav.map((group, gi) => (
          <div key={gi} className={gi ? 'braq-nav-group' : undefined}>
            {group.label && !narrow && <div className="braq-nav-group-label">{group.label}</div>}
            {group.label && narrow && <div style={{ height: 1, background: 'var(--line-2)', margin: '0 10px 10px' }} />}
            {group.items.map((item) => {
              const active = isActive(item.key)
              const count = item.count ? counts[item.count] : 0
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`braq-nav-item${active ? ' active' : ''}`}
                  onClick={() => navigate(item.key)}
                  aria-current={active ? 'page' : undefined}
                  aria-label={narrow ? item.label : undefined}
                  title={narrow ? item.label : undefined}
                >
                  {item.icon}
                  {!narrow && <span className="braq-nav-label">{item.label}</span>}
                  {count > 0 && <span className="braq-nav-count">{count > 99 ? '99+' : count}</span>}
                </button>
              )
            })}
          </div>
        ))}
      </nav>
    </>
  )

  const initial = staff?.name?.charAt(0).toUpperCase() ?? '?'

  const userMenu = {
    items: [
      { key: 'who', disabled: true, label: (
        <div style={{ padding: '2px 0', minWidth: 180 }}>
          <div style={{ fontWeight: 600, color: 'var(--ink)' }}>{staff?.name ?? 'Staff'}</div>
          <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{staff?.email}</div>
        </div>
      ) },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: 'Log out' },
    ],
    onClick: ({ key }) => { if (key === 'logout') { logout(); navigate('/login') } },
  }

  return (
    <div className="braq-shell" style={{ '--sidebar-w': `${sidebarW}px` }}>
      {isMobile ? (
        <Drawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          placement="left"
          width={SIDEBAR_W + 16}
          closable={false}
          styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
        >
          {renderNav(false)}
        </Drawer>
      ) : (
        <aside className={`braq-sidebar${collapsed ? ' collapsed' : ''}`}>
          {renderNav(collapsed)}
        </aside>
      )}

      <div className="braq-main">
        <header className={`braq-topbar${scrolled ? ' scrolled' : ''}`}>
          <button
            type="button"
            className="braq-icon-btn"
            onClick={() => (isMobile ? setDrawerOpen((o) => !o) : setCollapsed((c) => !c))}
            aria-label={isMobile ? 'Open navigation' : collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isMobile ? <MenuOutlined /> : collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>
          {isMobile && (
            <img src="/logo.png" alt="Braq Uni" style={{ width: 30, height: 30, borderRadius: '50%', background: '#0b0b0b' }} />
          )}

          <div style={{ flex: 1 }} />

          <button
            type="button"
            className="braq-icon-btn"
            onClick={toggle}
            aria-label={mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            title={mode === 'dark' ? 'Light theme' : 'Dark theme'}
          >
            {mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
          </button>

          <Dropdown menu={userMenu} trigger={['click']} placement="bottomRight">
            <button type="button" className="braq-user" aria-label="Account menu">
              <span className="braq-avatar">{initial}</span>
              <span className="braq-user-text">
                <div className="braq-user-name">{staff?.name ?? 'Staff'}</div>
                <div className="braq-user-role">{staff?.role ?? ''}</div>
              </span>
            </button>
          </Dropdown>
        </header>

        <main key={location.pathname} className="braq-content braq-route">
          <Suspense fallback={<div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  )
}
