import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Tag, Typography, Select, Spin, Alert, message, Space, Input,
} from 'antd'
import { ArrowLeftOutlined, WarningOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { getTicket, updateTicket } from '../../api/tickets.js'
import { listStaff } from '../../api/staff.js'

const { Title, Text } = Typography

const STATUS_OPTIONS = [
  { value: 'open',        label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved',    label: 'Resolved' },
  { value: 'closed',      label: 'Closed' },
]

const STATUS_COLORS = {
  open:        'processing',
  in_progress: 'warning',
  resolved:    'success',
  closed:      'default',
}

const CATEGORY_LABELS = {
  wrong_item:    'Wrong item received',
  defective:     'Defective item',
  missing_item:  'Missing item',
  account_query: 'Account Query',
  other:         'Other',
}

export default function TicketDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()

  const { data, isLoading, error } = useQuery({
    queryKey: ['ticket', id],
    queryFn: () => getTicket(id),
  })

  const { data: staffData } = useQuery({
    queryKey: ['staff-list'],
    queryFn: listStaff,
  })

  const updateMutation = useMutation({
    mutationFn: (values) => updateTicket(id, values),
    onSuccess: () => {
      message.success('Ticket updated')
      qc.invalidateQueries({ queryKey: ['ticket', id] })
      qc.invalidateQueries({ queryKey: ['tickets'] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Update failed'),
  })

  if (isLoading) return <Spin size="large" style={{ display: 'block', marginTop: 80 }} />
  if (error) return <Alert type="error" message="Failed to load ticket" />

  const { ticket } = data
  const staffList = staffData?.staff ?? []
  const isOverdue = ticket.is_overdue

  return (
    <div>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/tickets')}
        style={{ marginBottom: 16 }}
      >
        Back to Tickets
      </Button>

      <Card
        title={
          <Space>
            <Title level={4} style={{ margin: 0 }}>Support Ticket</Title>
            <Tag color={STATUS_COLORS[ticket.status] ?? 'default'}>
              {ticket.status?.replace('_', ' ')}
            </Tag>
            <Tag>{CATEGORY_LABELS[ticket.category] ?? ticket.category}</Tag>
            {isOverdue && <Tag color="error" icon={<WarningOutlined />}>Overdue</Tag>}
          </Space>
        }
        style={{ marginBottom: 16 }}
      >
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="Client">
            <Text strong>{ticket.client_name ?? '—'}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="WhatsApp">
            {ticket.client_wa ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Order Ref">
            {ticket.order_reference ?? '—'}
          </Descriptions.Item>
          <Descriptions.Item label="SLA Due">
            <Text type={isOverdue ? 'danger' : 'secondary'}>
              {ticket.sla_due_at ? dayjs(ticket.sla_due_at).format('DD MMM YYYY HH:mm') : '—'}
            </Text>
          </Descriptions.Item>
          <Descriptions.Item label="Assigned To">
            {ticket.assigned_name ?? <Text type="secondary">Unassigned</Text>}
          </Descriptions.Item>
          <Descriptions.Item label="Created">
            {dayjs(ticket.created_at).format('DD MMM YYYY HH:mm')}
          </Descriptions.Item>
          {ticket.description && (
            <Descriptions.Item label="Description" span={2}>
              {ticket.description}
            </Descriptions.Item>
          )}
          {ticket.resolved_at && (
            <Descriptions.Item label="Resolved At" span={2}>
              {dayjs(ticket.resolved_at).format('DD MMM YYYY HH:mm')}
            </Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card title="Actions" size="small">
        <Space direction="vertical" style={{ width: '100%' }} size={20}>
          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>Update Status</div>
            <Select
              value={ticket.status}
              options={STATUS_OPTIONS}
              style={{ width: 200 }}
              onChange={(v) => updateMutation.mutate({ status: v })}
              loading={updateMutation.isPending}
            />
          </div>

          <div>
            <div style={{ marginBottom: 6, fontWeight: 500 }}>Assign To</div>
            <Select
              value={ticket.assigned_staff_id ?? undefined}
              placeholder="Select staff member"
              options={staffList.map((s) => ({ value: s.id, label: `${s.name} (${s.role})` }))}
              style={{ width: 280 }}
              onChange={(v) => updateMutation.mutate({ assignedStaffId: v })}
              loading={updateMutation.isPending}
              allowClear
            />
          </div>
        </Space>
      </Card>
    </div>
  )
}
