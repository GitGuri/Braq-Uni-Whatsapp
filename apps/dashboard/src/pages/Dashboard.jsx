import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Row, Col, Card, Statistic, Table, Tag, Typography, Spin, Badge } from 'antd'
import {
  ShoppingCartOutlined, AlertOutlined, CustomerServiceOutlined,
  MessageOutlined, ClockCircleOutlined, FileTextOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import { listOrders } from '../api/orders.js'
import { listTickets } from '../api/tickets.js'
import { listQuotations } from '../api/quotations.js'
import { getUnreadCount } from '../api/conversations.js'
import StageTag from '../components/StageTag.jsx'
import { useAuth } from '../auth/AuthContext.jsx'

dayjs.extend(relativeTime)

const { Title, Text } = Typography

export default function Dashboard() {
  const navigate = useNavigate()
  const { staff } = useAuth()

  const { data: ordersData, isLoading: loadingOrders } = useQuery({
    queryKey: ['orders', 'recent'],
    queryFn: () => listOrders({ limit: 10 }),
  })

  const { data: delayedData } = useQuery({
    queryKey: ['orders', 'delayed'],
    queryFn: () => listOrders({ isDelayed: 'true', limit: 100 }),
  })

  const { data: ticketsData } = useQuery({
    queryKey: ['tickets', 'open'],
    queryFn: () => listTickets({ status: 'open' }),
  })

  const { data: unreadData, isLoading: loadingUnread } = useQuery({
    queryKey: ['unread-count'],
    queryFn: getUnreadCount,
    refetchInterval: 15_000,
  })

  const { data: activeOrdersData } = useQuery({
    queryKey: ['orders', 'active'],
    queryFn: () => listOrders({ active: 'true', limit: 500 }),
  })

  const { data: draftQuotationsData } = useQuery({
    queryKey: ['quotations', 'draft'],
    queryFn: () => listQuotations({ status: 'draft' }),
    refetchInterval: 30_000,
  })

  const recentOrders    = ordersData?.orders ?? []
  const delayedCount    = delayedData?.orders?.length ?? 0
  const openTickets     = ticketsData?.tickets?.length ?? 0
  const waitingInbox    = unreadData?.waiting ?? 0
  const activeOrders    = activeOrdersData?.orders?.length ?? 0
  const draftQuotations = draftQuotationsData?.quotations?.length ?? 0

  const hour = dayjs().hour()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  const STATS = [
    {
      title: 'Active Orders',
      value: activeOrders,
      icon: <ShoppingCartOutlined />,
      color: '#1677ff',
      path: '/orders',
    },
    {
      title: 'Quotations to Approve',
      value: draftQuotations,
      icon: <FileTextOutlined />,
      color: draftQuotations > 0 ? '#d46b08' : '#3f8600',
      path: '/quotations',
    },
    {
      title: 'Inbox — Waiting',
      value: waitingInbox,
      icon: <MessageOutlined />,
      color: waitingInbox > 0 ? '#d46b08' : '#3f8600',
      path: '/inbox',
      suffix: waitingInbox > 0 ? <Badge status="processing" color="orange" /> : null,
    },
    {
      title: 'Open Tickets',
      value: openTickets,
      icon: <CustomerServiceOutlined />,
      color: openTickets > 0 ? '#cf1322' : '#3f8600',
      path: '/tickets',
    },
    {
      title: 'Delayed Orders',
      value: delayedCount,
      icon: <AlertOutlined />,
      color: delayedCount > 0 ? '#cf1322' : '#3f8600',
      path: '/orders',
    },
  ]

  const columns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      render: (ref, row) => (
        <a style={{ fontWeight: 600 }} onClick={() => navigate(`/orders/${row.id}`)}>
          {ref}
        </a>
      ),
    },
    {
      title: 'Client',
      render: (_, row) => row.client_name ?? row.client?.name ?? '—',
    },
    {
      title: 'Type',
      dataIndex: 'client_type',
      render: (v) => v ? <Tag>{v}</Tag> : '—',
    },
    {
      title: 'Stage',
      dataIndex: 'stage',
      render: (stage) => <StageTag stage={stage} />,
    },
    {
      title: 'Flags',
      render: (_, row) => (
        <>
          {row.is_urgent  && <Tag color="red"   style={{ marginRight: 4 }}>Urgent</Tag>}
          {row.is_delayed && <Tag color="orange">Delayed</Tag>}
        </>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (v) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {dayjs(v).format('DD MMM YYYY')}
        </Text>
      ),
    },
  ]

  return (
    <div>
      {/* Greeting header */}
      <div style={{ marginBottom: 28 }}>
        <Title level={4} style={{ margin: 0, fontWeight: 700 }}>
          {greeting}, {staff?.name?.split(' ')[0]} 👋
        </Title>
        <Text type="secondary">
          Here's what needs your attention today — {dayjs().format('dddd, D MMMM YYYY')}
        </Text>
      </div>

      {/* KPI cards */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {STATS.map((s) => (
          <Col xs={24} sm={12} xl={6} key={s.title}>
            <Card
              hoverable
              onClick={() => navigate(s.path)}
              style={{ cursor: 'pointer', borderRadius: 10 }}
              bodyStyle={{ padding: '20px 24px' }}
            >
              <Statistic
                title={
                  <Text style={{ fontSize: 13, color: '#666' }}>{s.title}</Text>
                }
                value={s.value}
                prefix={
                  <span style={{ color: s.color, marginRight: 4 }}>{s.icon}</span>
                }
                suffix={s.suffix}
                valueStyle={{ color: s.color, fontSize: 28, fontWeight: 700 }}
              />
            </Card>
          </Col>
        ))}
      </Row>

      {/* Recent orders */}
      <Card
        title={
          <span style={{ fontWeight: 600 }}>
            <ClockCircleOutlined style={{ marginRight: 8, color: '#1677ff' }} />
            Recent Orders
          </span>
        }
        extra={
          <a onClick={() => navigate('/orders')} style={{ fontSize: 13 }}>
            View all orders →
          </a>
        }
        bodyStyle={{ padding: 0 }}
        style={{ borderRadius: 10 }}
      >
        {loadingOrders ? (
          <div style={{ padding: 40, textAlign: 'center' }}>
            <Spin />
          </div>
        ) : (
          <Table
            dataSource={recentOrders}
            columns={columns}
            rowKey="id"
            pagination={false}
            size="small"
            onRow={(row) => ({ onClick: () => navigate(`/orders/${row.id}`), style: { cursor: 'pointer' } })}
          />
        )}
      </Card>
    </div>
  )
}
