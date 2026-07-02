import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Descriptions, Button, Tag, Typography, Table, Form, Input,
  Select, Spin, Alert, message, Space, Modal,
} from 'antd'
import { ArrowLeftOutlined, EditOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { getClient, updateClient } from '../../api/clients.js'
import StageTag from '../../components/StageTag.jsx'

const { Title } = Typography

const CLIENT_TYPES = ['retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller']

export default function ClientDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [editOpen, setEditOpen] = useState(false)
  const [form] = Form.useForm()

  const { data, isLoading, error } = useQuery({
    queryKey: ['client', id],
    queryFn: () => getClient(id),
  })

  const updateMutation = useMutation({
    mutationFn: (values) => updateClient(id, values),
    onSuccess: () => {
      message.success('Client updated')
      setEditOpen(false)
      qc.invalidateQueries({ queryKey: ['client', id] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Update failed'),
  })

  if (isLoading) return <Spin size="large" style={{ display: 'block', marginTop: 80 }} />
  if (error) return <Alert type="error" message="Failed to load client" />

  const { client, orders } = data

  const orderColumns = [
    {
      title: 'Reference',
      dataIndex: 'reference',
      render: (ref, row) => <a onClick={() => navigate(`/orders/${row.id}`)}>{ref}</a>,
    },
    { title: 'Stage', dataIndex: 'stage', render: (s) => <StageTag stage={s} /> },
    {
      title: 'Flags',
      render: (_, row) => (
        <Space size={4}>
          {row.is_urgent && <Tag color="red">Urgent</Tag>}
          {row.is_delayed && <Tag color="orange">Delayed</Tag>}
        </Space>
      ),
    },
    { title: 'Created', dataIndex: 'created_at', render: (v) => dayjs(v).format('DD MMM YYYY') },
  ]

  return (
    <div>
      <Button
        icon={<ArrowLeftOutlined />}
        onClick={() => navigate('/clients')}
        style={{ marginBottom: 16 }}
      >
        Back to Clients
      </Button>

      <Card
        title={<Title level={4} style={{ margin: 0 }}>{client.name ?? client.wa_id}</Title>}
        extra={
          <Button
            icon={<EditOutlined />}
            onClick={() => {
              form.setFieldsValue(client)
              setEditOpen(true)
            }}
          >
            Edit
          </Button>
        }
        style={{ marginBottom: 16 }}
      >
        <Descriptions bordered size="small" column={{ xs: 1, sm: 2 }}>
          <Descriptions.Item label="WhatsApp">{client.wa_id}</Descriptions.Item>
          <Descriptions.Item label="Email">{client.email ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Client Type">
            {client.client_type ? <Tag>{client.client_type}</Tag> : '—'}
          </Descriptions.Item>
          <Descriptions.Item label="Organization">{client.organization ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Contact Person">{client.contact_person ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Joined">
            {dayjs(client.created_at).format('DD MMM YYYY')}
          </Descriptions.Item>
          {client.crm_notes && (
            <Descriptions.Item label="CRM Notes" span={2}>{client.crm_notes}</Descriptions.Item>
          )}
        </Descriptions>
      </Card>

      <Card title="Order History">
        <Table
          dataSource={orders ?? []}
          columns={orderColumns}
          rowKey="id"
          size="small"
          pagination={false}
          locale={{ emptyText: 'No orders yet' }}
        />
      </Card>

      <Modal
        title="Edit Client"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        footer={null}
        width={480}
      >
        <Form form={form} layout="vertical" onFinish={(v) => updateMutation.mutate(v)} style={{ marginTop: 16 }}>
          <Form.Item name="name" label="Name">
            <Input />
          </Form.Item>
          <Form.Item name="email" label="Email">
            <Input type="email" />
          </Form.Item>
          <Form.Item name="client_type" label="Client Type">
            <Select
              allowClear
              options={CLIENT_TYPES.map((t) => ({ value: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))}
            />
          </Form.Item>
          <Form.Item name="organization" label="Organization">
            <Input />
          </Form.Item>
          <Form.Item name="contact_person" label="Contact Person">
            <Input />
          </Form.Item>
          <Form.Item name="crm_notes" label="CRM Notes">
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => setEditOpen(false)} style={{ marginRight: 8 }}>Cancel</Button>
            <Button type="primary" htmlType="submit" loading={updateMutation.isPending}>Save Changes</Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
