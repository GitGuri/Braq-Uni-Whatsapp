import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  App, Table, Button, Modal, Form, Input, Select, Popconfirm,
} from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { listStaff, createStaff, deleteStaff } from '../../api/staff.js'
import { errorMessage } from '../../utils/errorMessage.js'
import { useCan } from '../../lib/useCan.js'
import NoAccess from '../../components/NoAccess.jsx'
import { initials } from '../../lib/format.js'

const ROLES = ['admin', 'consultant', 'manager']

const ROLE_LABEL = {
  admin:      'Admin',
  consultant: 'Consultant',
  manager:    'Manager',
}
const ROLE_HELP = {
  admin:      'Admin: everything, including staff accounts',
  consultant: 'Consultant: day-to-day work; cannot change prices, purchase orders or staff',
  manager:    'Manager: everything except adding or removing staff',
}


/** Admin: staff accounts. Other roles are told plainly that the page is not theirs. */
export default function StaffList() {
  const allowed = useCan()('staff.manage')
  if (!allowed) return <NoAccess title="Staff" who="admins" />
  return <StaffManager />
}

function StaffManager() {
  const qc = useQueryClient()
  const { message } = App.useApp()
  const canManage = useCan()('staff.manage')
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
      message.success('Staff account created')
      setModalOpen(false)
      form.resetFields()
      qc.invalidateQueries({ queryKey: ['staff-list'] })
    },
    onError: (err) => message.error(errorMessage(err, 'Could not create the staff account')),
  })

  const deleteMutation = useMutation({
    mutationFn: (id) => deleteStaff(id),
    onSuccess: () => {
      message.success('Staff account deleted')
      qc.invalidateQueries({ queryKey: ['staff-list'] })
    },
    onError: (err) => message.error(errorMessage(err, 'Could not delete the staff account')),
  })

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      render: (v) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, whiteSpace: 'nowrap' }}>
          <span className="braq-avatar" aria-hidden="true">{initials(v)}</span>
          <span style={{ fontWeight: 600 }}>{v}</span>
        </span>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
      render: (v) => <span style={{ color: 'var(--ink-2)' }}>{v}</span>,
    },
    {
      title: 'Role',
      dataIndex: 'role',
      key: 'role',
      render: (v) => <span className="braq-pill">{ROLE_LABEL[v] ?? v}</span>,
    },
    {
      title: 'Added',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v) => (
        <span style={{ fontSize: 13, color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>
          {v ? new Date(v).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'}
        </span>
      ),
    },
    canManage && {
      title: '',
      key: 'actions',
      width: 60,
      render: (_, r) => (
        <Popconfirm
          title={`Delete ${r.name}?`}
          description="Their account is removed permanently and they can no longer sign in."
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
            aria-label={`Delete ${r.name}`}
            loading={deleteMutation.isPending && deleteMutation.variables === r.id}
          />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">Staff</h1>
          <div className="braq-page-subtitle">Everyone who can sign in to Braq Connect, and what their role lets them do.</div>
        </div>
        {canManage && (
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModalOpen(true)}>
            Add staff member
          </Button>
        )}
      </div>

      <section className="braq-panel" style={{ overflow: 'hidden' }}>
        <Table
          dataSource={staff}
          columns={columns.filter(Boolean)}
          rowKey="id"
          loading={isLoading}
          size="middle"
          pagination={{ pageSize: 20, hideOnSinglePage: true }}
          scroll={{ x: 'max-content' }}
          locale={{ emptyText: 'No staff accounts yet. Use Add staff member to invite someone.' }}
        />
      </section>

      <Modal
        title="Add staff member"
        open={modalOpen}
        onCancel={() => { setModalOpen(false); form.resetFields() }}
        footer={null}
        width={480}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={(v) => createMutation.mutate(v)}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="name" label="Full name" rules={[{ required: true, message: 'Enter their name' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="email"
            label="Email address"
            extra="They sign in with this address"
            rules={[
              { required: true, message: 'Enter their email address' },
              { type: 'email', message: 'Enter a valid email' },
            ]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="role" label="Role" rules={[{ required: true, message: 'Choose a role' }]}>
            <Select
              placeholder="Choose a role"
              options={ROLES.map((r) => ({
                value: r,
                label: ROLE_HELP[r] ?? r,
              }))}
            />
          </Form.Item>
          <Form.Item
            name="password"
            label="Password"
            extra="At least 8 characters. Share it with them privately."
            rules={[{ required: true, message: 'Set a password' }, { min: 8, message: 'Use at least 8 characters' }]}
          >
            <Input.Password />
          </Form.Item>
          <Form.Item style={{ textAlign: 'right', marginBottom: 0 }}>
            <Button onClick={() => { setModalOpen(false); form.resetFields() }} style={{ marginRight: 8 }}>
              Cancel
            </Button>
            <Button type="primary" htmlType="submit" loading={createMutation.isPending}>
              Create account
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
