import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Row, Col, Card, Statistic, List, Tag, Typography, Spin, Badge, Space, Button, message } from 'antd'
import {
  ShoppingCartOutlined, AlertOutlined, CustomerServiceOutlined,
  MessageOutlined, FileTextOutlined, ClockCircleOutlined, ExclamationCircleOutlined,
  UserOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import { getKpis } from '../api/orders.js'
import { getUnreadCount } from '../api/conversations.js'
import { claimQuotation } from '../api/quotations.js'
import { claimTicket } from '../api/tickets.js'
import { useAuth } from '../auth/AuthContext.jsx'

dayjs.extend(relativeTime)

const { Text } = Typography

function kpiColor(count) {
  if (count === 0) return '#3f8600'
  if (count <= 4)  return '#d46b08'
  return '#cf1322'
}

function KpiCard({ title, value, icon, color, path, onClick }) {
  const navigate = useNavigate()
  return (
    <Card
      hoverable
      onClick={onClick ?? (() => navigate(path))}
      style={{ cursor: 'pointer', borderRadius: 10 }}
      bodyStyle={{ padding: '20px 24px' }}
    >
      <Statistic
        title={<Text style={{ fontSize: 13, color: '#666' }}>{title}</Text>}
        value={value ?? 0}
        prefix={<span style={{ color, marginRight: 4 }}>{icon}</span>}
        valueStyle={{ color, fontSize: 28, fontWeight: 700 }}
      />
    </Card>
  )
}

export default function Dashboard() {
  const navigate  = useNavigate()
  const { staff } = useAuth()
  const qc        = useQueryClient()
  const [msgApi, ctx] = message.useMessage()

  const { data: kpiData, isLoading } = useQuery({
    queryKey: ['dashboard-kpis'],
    queryFn: getKpis,
    refetchInterval: 30_000,
  })

  const { data: unreadData } = useQuery({
    queryKey: ['unread-count'],
    queryFn: getUnreadCount,
    refetchInterval: 15_000,
  })

  const claimQMutation = useMutation({
    mutationFn: (id) => claimQuotation(id),
    onSuccess: () => {
      msgApi.success('Quotation claimed — it\'s yours!')
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] })
      qc.invalidateQueries({ queryKey: ['quotations'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Claim failed'),
  })

  const claimTMutation = useMutation({
    mutationFn: (id) => claimTicket(id),
    onSuccess: () => {
      msgApi.success('Ticket claimed!')
      qc.invalidateQueries({ queryKey: ['dashboard-kpis'] })
      qc.invalidateQueries({ queryKey: ['tickets'] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Claim failed'),
  })

  const kpis      = kpiData?.kpis ?? {}
  const attention = kpiData?.attention ?? []
  const waiting   = unreadData?.waiting ?? 0

  const newEnquiries  = Number(kpis.new_enquiries ?? 0)
  const quotesPending = Number(kpis.quotations_awaiting_pricing ?? 0)
  const activeOrders  = Number(kpis.active_orders ?? 0)
  const openTickets   = Number(kpis.open_tickets ?? 0)
  const onHoldOrders  = Number(kpis.on_hold_orders ?? 0)

  const hour     = dayjs().hour()
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <div>
      {ctx}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 2 }}>
          {greeting}, {staff?.name?.split(' ')[0]}
        </div>
        <Text type="secondary">{dayjs().format('dddd, D MMMM YYYY')}</Text>
      </div>

      {isLoading ? (
        <div style={{ textAlign: 'center', padding: 60 }}><Spin size="large" /></div>
      ) : (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
            <Col xs={24} sm={12} xl={8}>
              <KpiCard title="New Enquiries" value={newEnquiries}
                icon={<MessageOutlined />}
                color={newEnquiries === 0 ? '#3f8600' : '#d46b08'} path="/inbox" />
            </Col>
            <Col xs={24} sm={12} xl={8}>
              <KpiCard title="Quotations Awaiting Pricing" value={quotesPending}
                icon={<FileTextOutlined />} color={kpiColor(quotesPending)} path="/quotations" />
            </Col>
            <Col xs={24} sm={12} xl={8}>
              <KpiCard title="Active Orders" value={activeOrders}
                icon={<ShoppingCartOutlined />} color="#1677ff" path="/orders" />
            </Col>
            <Col xs={24} sm={12} xl={8}>
              <KpiCard title="Open Tickets" value={openTickets}
                icon={<CustomerServiceOutlined />} color={kpiColor(openTickets)} path="/tickets" />
            </Col>
            <Col xs={24} sm={12} xl={8}>
              <KpiCard title="Delayed / On Hold" value={onHoldOrders}
                icon={<AlertOutlined />} color={kpiColor(onHoldOrders)} path="/orders"
                onClick={() => navigate('/orders?onHold=true')} />
            </Col>
            <Col xs={24} sm={12} xl={8}>
              <KpiCard title="Inbox — Waiting" value={waiting}
                icon={<MessageOutlined />}
                color={waiting === 0 ? '#3f8600' : waiting <= 4 ? '#d46b08' : '#cf1322'}
                path="/inbox" />
            </Col>
          </Row>

          {/* Needs-attention feed */}
          <Card
            title={
              <Space>
                <ExclamationCircleOutlined style={{ color: '#cf1322' }} />
                <span style={{ fontWeight: 600 }}>Needs Attention</span>
              </Space>
            }
            style={{ borderRadius: 10 }}
            bodyStyle={{ padding: 0 }}
          >
            {attention.length === 0 ? (
              <div style={{ padding: 32, textAlign: 'center' }}>
                <Text type="secondary">All clear — nothing needs attention right now. ✅</Text>
              </div>
            ) : (
              <List
                dataSource={attention}
                renderItem={(item) => {
                  const overdue = item.is_overdue
                  const path    = item.type === 'quotation' ? '/quotations' : `/tickets/${item.id}`
                  const label   = item.type === 'quotation' ? 'Quotation' : 'Ticket'
                  const deadlineText = item.deadline
                    ? (overdue
                        ? `Overdue ${dayjs(item.deadline).fromNow()}`
                        : `Due ${dayjs(item.deadline).fromNow()}`)
                    : ''

                  const isClaimed = !!item.assigned_staff_id
                  const isPending =
                    (item.type === 'quotation' && claimQMutation.isPending) ||
                    (item.type === 'ticket'    && claimTMutation.isPending)

                  return (
                    <List.Item
                      style={{ padding: '12px 20px', cursor: 'pointer' }}
                      onClick={(e) => {
                        // Don't navigate when clicking the Claim button
                        if (e.target.closest('button')) return
                        navigate(path)
                      }}
                      actions={[
                        isClaimed ? (
                          <Space key="claimer" size={4}>
                            <UserOutlined style={{ color: '#999' }} />
                            <Text type="secondary" style={{ fontSize: 12 }}>{item.assigned_name}</Text>
                          </Space>
                        ) : (
                          <Button
                            key="claim"
                            size="small"
                            type="primary"
                            loading={isPending}
                            onClick={(e) => {
                              e.stopPropagation()
                              item.type === 'quotation'
                                ? claimQMutation.mutate(item.id)
                                : claimTMutation.mutate(item.id)
                            }}
                          >
                            Claim
                          </Button>
                        ),
                      ]}
                    >
                      <List.Item.Meta
                        avatar={
                          overdue ? <Badge status="error" /> : <Badge status="warning" />
                        }
                        title={
                          <Space>
                            <Tag color={item.type === 'quotation' ? 'blue' : 'orange'} style={{ fontSize: 11 }}>
                              {label}
                            </Tag>
                            <Text strong style={{ fontSize: 13 }}>
                              {item.client_name ?? item.reference}
                            </Text>
                            {item.reference && item.type === 'quotation' && (
                              <Text type="secondary" style={{ fontSize: 11, fontFamily: 'monospace' }}>
                                {item.reference}
                              </Text>
                            )}
                            {overdue && <Tag color="red" style={{ fontSize: 11 }}>Overdue</Tag>}
                          </Space>
                        }
                        description={
                          <Text type="secondary" style={{ fontSize: 12 }}>
                            <ClockCircleOutlined style={{ marginRight: 4 }} />
                            {deadlineText}
                          </Text>
                        }
                      />
                    </List.Item>
                  )
                }}
              />
            )}
          </Card>
        </>
      )}
    </div>
  )
}
