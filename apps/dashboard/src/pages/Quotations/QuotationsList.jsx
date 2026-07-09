import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Table, Tag, Typography, Button, Space, Card, message } from 'antd'
import { UserOutlined, FilePdfOutlined, RobotOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import { listQuotations } from '../../api/quotations.js'

dayjs.extend(relativeTime)

const { Text } = Typography

const STATUS_COLORS = {
  draft: 'orange', sent: 'blue', accepted: 'green', rejected: 'red', expired: 'default',
}

export default function QuotationsList() {
  const navigate = useNavigate()
  const [msgApi, ctx] = message.useMessage()

  const { data, isLoading } = useQuery({
    queryKey: ['quotations'],
    queryFn:  () => listQuotations({}),
  })

  const quotations = data?.quotations ?? []

  const columns = [
    {
      title: 'Reference',
      render: (_, r) => (
        <div>
          <Text strong style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.reference}</Text>
          {r.auto_quoted && (
            <Tag icon={<RobotOutlined />} color="purple" style={{ marginLeft: 8, fontSize: 10 }}>
              AI Auto
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Client',
      render: (_, r) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{r.client_name ?? '—'}</Text>
          {r.client_org && (
            <div><Text type="secondary" style={{ fontSize: 11 }}>{r.client_org}</Text></div>
          )}
        </div>
      ),
    },
    {
      title: 'Status',
      render: (_, r) => (
        <Tag color={STATUS_COLORS[r.status] ?? 'default'} style={{ fontSize: 11 }}>
          {r.status}
        </Tag>
      ),
    },
    {
      title: 'Total',
      dataIndex: 'total',
      render: (v) => v != null ? `R ${Number(v).toFixed(2)}` : '—',
    },
    {
      title: 'SLA',
      render: (_, r) => {
        if (r.status !== 'draft' || !r.sla_remind_at) return '—'
        const over = dayjs(r.sla_remind_at).isBefore(dayjs())
        return (
          <Text style={{ color: over ? '#cf1322' : '#d46b08', fontSize: 12 }}>
            {over ? '⚠ Overdue' : `Due ${dayjs(r.sla_remind_at).fromNow()}`}
          </Text>
        )
      },
    },
    {
      title: 'Assigned',
      render: (_, r) => {
        if (r.auto_quoted) {
          return (
            <Space size={4}>
              <RobotOutlined style={{ color: '#722ed1' }} />
              <Text style={{ fontSize: 12, color: '#722ed1' }}>AI Bot</Text>
            </Space>
          )
        }
        return r.assigned_name ? (
          <Space size={4}>
            <UserOutlined style={{ color: '#999' }} />
            <Text type="secondary" style={{ fontSize: 12 }}>{r.assigned_name}</Text>
          </Space>
        ) : (
          <Text type="secondary" style={{ fontSize: 12 }}>Unassigned</Text>
        )
      },
    },
    {
      title: 'Created',
      dataIndex: 'created_at',
      render: (v) => (
        <Text type="secondary" style={{ fontSize: 12 }}>{dayjs(v).format('DD MMM YYYY')}</Text>
      ),
    },
    {
      title: 'PDF',
      key: 'pdf',
      width: 100,
      render: (_, r) =>
        r.status !== 'draft' ? (
          <Button
            size="small"
            icon={<FilePdfOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              window.open(`/api/quotations/${r.id}/pdf`, '_blank')
            }}
            style={{ fontSize: 12 }}
          >
            PDF
          </Button>
        ) : null,
    },
  ]

  return (
    <>
      {ctx}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Text style={{ fontSize: 18, fontWeight: 700 }}>Quotations</Text>
      </div>

      <Card styles={{ body: { padding: 0 } }} style={{ borderRadius: 10 }}>
        <Table
          dataSource={quotations}
          columns={columns}
          rowKey="id"
          loading={isLoading}
          pagination={{ pageSize: 25, showSizeChanger: false }}
          size="middle"
          onRow={(r) => ({
            style: { cursor: 'pointer' },
            onClick: () => navigate(`/quotations/${r.id}/build`),
          })}
        />
      </Card>
    </>
  )
}
