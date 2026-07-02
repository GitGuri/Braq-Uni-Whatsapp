import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Row, Col, Card, Statistic, Table, Tag, Typography, Spin, Alert } from 'antd'
import {
  ShoppingCartOutlined,
  AlertOutlined,
  CustomerServiceOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import { listOrders } from '../api/orders.js'
import { listTickets } from '../api/tickets.js'
import StageTag from '../components/StageTag.jsx'

const { Title } = Typography

export default function Dashboard() {
  const navigate = useNavigate()

  const { data: ordersData, isLoading: loadingOrders } = useQuery({
    queryKey: ['orders', 'recent'],
    queryFn: () => listOrders({ limit: 10 }),
  })

  const { data: delayedData } = useQuery({
    queryKey: ['orders', 'delayed'],
    queryFn: () => listOrders({ isDelayed: true, limit: 1 }),
  })

  const { data: ticketsData } = useQuery({
    queryKey: ['tickets', 'open'],
    queryFn: () => listTickets({ status: 'open' }),
  })

  const recentOrders = ordersData?.orders ?? []
  const totalOrders = ordersData?.orders?.length ?? 0
  const delayedCount = delayedData?.orders?.length ?? 0
  const openTickets = ticketsData?.tickets?.length ?? 0

  const columns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      key: 'reference',
      render: (ref, row) => (
        <a onClick={() => navigate(`/orders/${row.id}`)}>{ref}</a>
      ),
    },
    {
      title: 'Client',
      dataIndex: ['client', 'name'],
      key: 'client',
      render: (_, row) => row.client_name ?? row.client?.name ?? '—',
    },
    {
      title: 'Stage',
      dataIndex: 'stage',
      key: 'stage',
      render: (stage) => <StageTag stage={stage} />,
    },
    {
      title: 'Delayed',
      dataIndex: 'is_delayed',
      key: 'is_delayed',
      render: (v) => v ? <Tag color="error">Delayed</Tag> : null,
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => dayjs(v).format('DD MMM YYYY'),
    },
  ]

  return (
    <div>
      <Title level={4} style={{ marginBottom: 24 }}>
        Overview
      </Title>

      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Recent Orders"
              value={totalOrders}
              prefix={<ShoppingCartOutlined />}
              valueStyle={{ color: '#1677ff' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Delayed Orders"
              value={delayedCount}
              prefix={<AlertOutlined />}
              valueStyle={{ color: delayedCount > 0 ? '#cf1322' : '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Open Tickets"
              value={openTickets}
              prefix={<CustomerServiceOutlined />}
              valueStyle={{ color: openTickets > 0 ? '#d46b08' : '#3f8600' }}
            />
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          <Card>
            <Statistic
              title="Active This Session"
              value={dayjs().format('HH:mm')}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: '#595959' }}
            />
          </Card>
        </Col>
      </Row>

      <Card title="Recent Orders">
        {loadingOrders ? (
          <Spin />
        ) : (
          <Table
            dataSource={recentOrders}
            columns={columns}
            rowKey="id"
            pagination={false}
            size="small"
            onRow={(row) => ({ onClick: () => navigate(`/orders/${row.id}`) })}
            style={{ cursor: 'pointer' }}
          />
        )}
      </Card>
    </div>
  )
}
