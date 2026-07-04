import { useState } from 'react'
import { Outlet, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Avatar, Dropdown, Typography, theme, Badge } from 'antd'
import {
  DashboardOutlined,
  ShoppingCartOutlined,
  TeamOutlined,
  FileTextOutlined,
  AppstoreOutlined,
  FileProtectOutlined,
  CustomerServiceOutlined,
  NotificationOutlined,
  LogoutOutlined,
  UserOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MessageOutlined,
  BookOutlined,
  SettingOutlined,
} from '@ant-design/icons'
import { useQuery } from '@tanstack/react-query'
import { useAuth } from '../auth/AuthContext.jsx'
import { getUnreadCount } from '../api/conversations.js'

const { Header, Sider, Content } = Layout
const { Text } = Typography

function InboxLabel({ collapsed, waiting }) {
  if (collapsed) return <Badge count={waiting} size="small" offset={[4, 0]}><span /></Badge>
  return (
    <span style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
      Inbox
      {waiting > 0 && (
        <Badge count={waiting} size="small" style={{ marginLeft: 8 }} />
      )}
    </span>
  )
}

export default function DashboardLayout() {
  const [collapsed, setCollapsed] = useState(false)
  const { staff, logout } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const { token } = theme.useToken()

  const { data: unreadData } = useQuery({
    queryKey: ['unread-count'],
    queryFn: getUnreadCount,
    refetchInterval: 15_000,
  })

  const waiting = unreadData?.waiting ?? 0

  const NAV_ITEMS = [
    { key: '/', icon: <DashboardOutlined />, label: 'Dashboard' },
    { key: '/inbox', icon: <MessageOutlined />, label: <InboxLabel collapsed={collapsed} waiting={waiting} /> },
    { type: 'divider' },
    { key: '/orders', icon: <ShoppingCartOutlined />, label: 'Orders' },
    { key: '/quotations', icon: <FileTextOutlined />, label: 'Quotations' },
    { key: '/purchase-orders', icon: <FileProtectOutlined />, label: 'Purchase Orders' },
    { type: 'divider' },
    { key: '/clients', icon: <TeamOutlined />, label: 'Clients' },
    { key: '/tickets', icon: <CustomerServiceOutlined />, label: 'Tickets' },
    { key: '/broadcasts', icon: <NotificationOutlined />, label: 'Broadcasts' },
    { type: 'divider' },
    { key: '/products', icon: <AppstoreOutlined />, label: 'Products' },
    { key: '/school-catalog', icon: <BookOutlined />, label: 'School Catalog' },
    { type: 'divider' },
    { key: '/staff', icon: <SettingOutlined />, label: 'Staff' },
  ]

  const selectedKey = NAV_ITEMS.filter(i => i.key && i.key !== '/').find(
    (item) => location.pathname.startsWith(item.key)
  )?.key ?? '/'

  const userMenu = {
    items: [
      {
        key: 'logout',
        icon: <LogoutOutlined />,
        label: 'Log out',
        danger: true,
        onClick: () => {
          logout()
          navigate('/login')
        },
      },
    ],
  }

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        trigger={null}
        width={220}
        style={{
          background: '#001529',
          position: 'fixed',
          height: '100vh',
          left: 0,
          top: 0,
          bottom: 0,
          zIndex: 100,
        }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: collapsed ? 'center' : 'flex-start',
            padding: collapsed ? 0 : '0 20px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {collapsed ? (
            <Text style={{ color: '#1677ff', fontSize: 20, fontWeight: 700 }}>B</Text>
          ) : (
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: 700, letterSpacing: 0.5 }}>
              Braq Connect
            </Text>
          )}
        </div>

        <Menu
          theme="dark"
          mode="inline"
          selectedKeys={[selectedKey]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ borderRight: 0, marginTop: 8 }}
        />
      </Sider>

      <Layout style={{ marginLeft: collapsed ? 80 : 220, transition: 'margin-left 0.2s' }}>
        <Header
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 99,
            background: token.colorBgContainer,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
            padding: '0 24px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <button
            onClick={() => setCollapsed(!collapsed)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontSize: 18,
              color: token.colorText,
              padding: '4px 8px',
              borderRadius: token.borderRadius,
            }}
          >
            {collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          </button>

          <Dropdown menu={userMenu} placement="bottomRight">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
              <Avatar icon={<UserOutlined />} style={{ background: '#1677ff' }} />
              <div style={{ lineHeight: 1.2 }}>
                <Text strong style={{ display: 'block', fontSize: 13 }}>
                  {staff?.name}
                </Text>
                <Text type="secondary" style={{ fontSize: 11, textTransform: 'capitalize' }}>
                  {staff?.role}
                </Text>
              </div>
            </div>
          </Dropdown>
        </Header>

        <Content style={{ margin: 24, minHeight: 'calc(100vh - 112px)' }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  )
}
