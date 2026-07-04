import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Tag, Typography, Table, Form, Input,
  Select, Spin, Alert, message, Space, Modal, Tabs,
} from 'antd'
import { ArrowLeftOutlined, EditOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { getClient, updateClient } from '../../api/clients.js'
import StageTag from '../../components/StageTag.jsx'

const { Text } = Typography

const STATUS_COLORS = {
  draft: 'orange', sent: 'blue', accepted: 'green', rejected: 'red',
}

export default function ClientDetail() {
  const { id }    = useParams()
  const navigate  = useNavigate()
  const qc        = useQueryClient()
  const [editOpen, setEditOpen] = useState(false)
  const [form]    = Form.useForm()
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading, error } = useQuery({
    queryKey: ['client', id],
    queryFn: () => getClient(id),
  })

  const updateMutation = useMutation({
    mutationFn: (values) => updateClient(id, values),
    onSuccess: () => {
      msgApi.success('Client updated')
      setEditOpen(false)
      qc.invalidateQueries({ queryKey: ['client', id] })
    },
    onError: (err) => msgApi.error(err.response?.data?.error ?? 'Update failed'),
  })

  if (isLoading) return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" /></div>
  if (error)     return <Alert type="error" message="Failed to load client" />

  const { client, orders = [], quotations = [] } = data

  const orderColumns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      render: (ref, row) => (
        <a style={{ fontFamily: 'monospace', fontWeight: 600 }} onClick={() => navigate(`/orders/${row.id}`)}>
          {ref}
        </a>
      ),
    },
    { title: 'Stage', dataIndex: 'stage', render: (s) => <StageTag stage={s} /> },
    {
      title: 'Status',
      render: (_, r) => r.is_on_hold ? <Tag color="red">On Hold</Tag> : null,
    },
    {
      title: 'Payment',
      dataIndex: 'payment_status',
      render: (v) => (
        <Tag color={v === 'paid_in_full' ? 'green' : v === 'deposit_paid' ? 'orange' : 'default'}>
          {v?.replace(/_/g, ' ')}
        </Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>,
    },
  ]

  const quotationColumns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      render: (v) => <Text strong style={{ fontFamily: 'monospace' }}>{v}</Text>,
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (s) => <Tag color={STATUS_COLORS[s] ?? 'default'}>{s}</Tag>,
    },
    {
      title: 'Total',
      dataIndex: 'total',
      render: (v) => v != null ? `R ${Number(v).toFixed(2)}` : '—',
    },
    {
      title: 'Date',
      dataIndex: 'created_at',
      render: (v) => <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>,
    },
  ]

  const tabItems = [
    {
      key: 'orders',
      label: `Orders (${orders.length})`,
      children: (
        <Table
          dataSource={orders}
          columns={orderColumns}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No orders yet' }}
        />
      ),
    },
    {
      key: 'quotations',
      label: `Quotations (${quotations.length})`,
      children: (
        <Table
          dataSource={quotations}
          columns={quotationColumns}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No quotations yet' }}
        />
      ),
    },
  ]

  return (
    <>
      {ctx}
      <Button type="link" onClick={() => navigate('/clients')} style={{ paddingLeft: 0, marginBottom: 12 }}>
        ← Back to Clients
      </Button>

      <Card
        title={
          <Space>
            <Text strong style={{ fontSize: 16 }}>{client.name ?? client.wa_id}</Text>
            {client.customer_number && (
              <Text type="secondary" style={{ fontSize: 12, fontFamily: 'monospace' }}>{client.customer_number}</Text>
            )}
            <Tag color={client.profile_complete ? 'green' : 'orange'}>
              {client.profile_complete ? 'Complete' : 'Incomplete Profile'}
            </Tag>
          </Space>
        }
        extra={
          <Button
            icon={<EditOutlined />}
            onClick={() => {
              form.setFieldsValue({
                name: client.name,
                organisation: client.organisation,
                school_name: client.school_name,
                physical_address: client.physical_address,
                client_type: client.client_type,
              })
              setEditOpen(true)
            }}
          >
            Edit
          </Button>
        }
        style={{ marginBottom: 16, borderRadius: 10 }}
      >
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="WhatsApp">{client.wa_id}</Descriptions.Item>
          <Descriptions.Item label="Client Type">
            {client.client_type ? <Tag>{client.client_type}</Tag> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Organisation">{client.organisation ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="School Name">{client.school_name ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Physical Address" span={2}>{client.physical_address ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Joined">{dayjs(client.created_at).format('DD MMM YYYY')}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card style={{ borderRadius: 10 }} bodyStyle={{ padding: '0 16px 16px' }}>
        <Tabs items={tabItems} />
      </Card>

      <Modal
        title="Edit Client"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => updateMutation.mutate(form.getFieldsValue())}
        okText="Save"
        okButtonProps={{ loading: updateMutation.isPending }}
        width={480}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Name">
            <Input />
          </Form.Item>
          <Form.Item name="client_type" label="Client Type">
            <Select
              allowClear
              options={['retail','school','corporate','hospitality','church','security','government','reseller']
                .map(t => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            />
          </Form.Item>
          <Form.Item name="organisation" label="Organisation">
            <Input />
          </Form.Item>
          <Form.Item name="school_name" label="School Name">
            <Input placeholder="For school uniform clients" />
          </Form.Item>
          <Form.Item name="physical_address" label="Physical Address">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
