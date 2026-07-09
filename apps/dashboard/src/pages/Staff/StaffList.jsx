import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Table, Card, Typography, Button, Tag, Modal, Form, Input, Select, message, Avatar, Space, Popconfirm,
} from 'antd'
import { PlusOutlined, UserOutlined, DeleteOutlined } from '@ant-design/icons'
import { listStaff, createStaff, deleteStaff } from '../../api/staff.js'

const { Title, Text } = Typography

const ROLES = ['admin', 'consultant', 'manager']

const ROLE_COLORS = {
  admin:      'red',
  consultant: 'blue',
  manager:    'green',
}

export default function StaffList() {
  const qc = useQueryClient()
  const [modalOpen, setModalOpen] = useState(false)
  const [form] = Form.useForm()

  const { data, isLoading } = useQuery({
    queryKey: ['staff-list'],
    queryFn: listStaff,
  })

  const staff = data?.staff ?? []

  const createMutation = useMutation({
    mutationFn: (values) => createStaff(values),
    onSuccess: () => {
      message.success('Staff member created')
      setModalOpen(false)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['staff-list'] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to create staff member'),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteStaff(id),
    onSuccess: () => {
      message.success('Staff member deleted')
      qc.invalidateQueries({ queryKey: ['staff-list'] })
    },
    onError: (err) => message.error(err.response?.data?.error ?? 'Failed to delete staff member'),
  })

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (v) => (
        <Space>
          <Avatar icon={<UserOutlined />} style={{ background: '#1677ff' }} size="small" />
          <Text strong>{v}</Text>
        </Space>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      render: (v) => <Text type="secondary">{v}</Text>,
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (v) => (
        <Tag color={ROLE_COLORS[v] ?? 'default'} style={{ textTransform: 'capitalize' }}>
          {v}
        </Tag>
      ),
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => (
        <Text type="secondary" style={{ fontSize: 12 }}>
          {v ? new Date(v).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
        </Text>
      ),
    },
    {
      title: '',
      key: 'actions',
      width: 60,
      render: (_, r) => (
        <Popconfirm
          title="Delete staff member?"
          description={`This will permanently remove ${r.name}.`}
          onConfirm={() => deleteMutation.mutate(r.id)}
          okText="Delete"
          okButtonProps={{ danger: true }}
          cancelText="Cancel"
        >
          <Button
            size="small"
            danger
            type="text"
            icon={<DeleteOutlined />}
            loading={deleteMutation.isPending && deleteMutation.variables === r.id}
          />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>Staff</Title>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
          Add Staff Member
        </Button>
      </div>

      <Card>
        <Table
          dataSource={staff}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20 }}
        />
      </Card>

      <Modal
        title="Add Staff Member"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        footer={null}
        width={480}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createMutation.mutate(v)}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="name" label="Full Name" rules={[{ required: true, message: 'Required' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email Address"
            rules={[
              { required: true, message: 'Required' },
              { type: 'email', message: 'Enter a valid email' },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true, message: 'Required' }]}>
            <Select
              options={ROLES.map((r) => ({
                value: r,
                label: r.charAt(0).toUpperCase() + r.slice(1),
              }))}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            rules={[{ required: true, message: 'Required' }, { min: 8, message: 'At least 8 characters' }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => { setModalOpen(false); form.resetFields() }} style={{ marginRight: 8 }}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
              Create
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
