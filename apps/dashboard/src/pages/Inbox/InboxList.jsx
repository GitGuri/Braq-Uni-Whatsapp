import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  List, Card, Typography, Tag, Badge, Select, Avatar, Space, Segmented, Empty, Spin,
} from 'antd'
import {
  MessageOutlined, ClockCircleOutlined, UserOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import relativeTime from 'dayjs/plugin/relativeTime.js'
import { listConversations } from '../../api/conversations.js'

dayjs.extend(relativeTime)

const { Title, Text } = Typography

const STATE_CONFIG = {
  awaiting_consultant: { label: 'Waiting',         color: 'warning' },
  consultant_active:   { label: 'Active',          color: 'processing' },
  new:                 { label: 'New',             color: 'default' },
  main_menu:           { label: 'Bot',             color: 'default' },
}

export default function InboxList() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState('awaiting_consultant')
  const [isOpen, setIsOpen] = useState('true')

  const { data, isLoading } = useQuery({
    queryKey: ['conversations', { state: filter || undefined, isOpen }],
    queryFn: () =>
      listConversations({ state: filter || undefined, isOpen, limit: 50 }),
    refetchInterval: 15_000,
  })

  const conversations = data?.conversations ?? []

  const segments = [
    { label: 'Waiting for me', value: 'awaiting_consultant' },
    { label: 'Active',         value: 'consultant_active' },
    { label: 'All open',       value: '' },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={4} style={{ margin: 0 }}>
          <Space>
            <MessageOutlined />
            Inbox
          </Space>
        </Title>
        <Select
          value={isOpen}
          options={[
            { value: 'true', label: 'Open conversations' },
            { value: 'false', label: 'Closed conversations' },
            { value: 'all', label: 'All conversations' },
          ]}
          onChange={setIsOpen}
          style={{ width: 180 }}
        />
      </div>

      <Card style={{ marginBottom: 16 }}>
        <Segmented
          options={segments}
          value={filter}
          onChange={setFilter}
          block
        />
      </Card>

      {isLoading ? (
        <Spin size="large" style={{ display: 'block', marginTop: 60 }} />
      ) : conversations.length === 0 ? (
        <Card>
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={
              filter === 'awaiting_consultant'
                ? 'No conversations waiting — you\'re all caught up!'
                : 'No conversations found'
            }
          />
        </Card>
      ) : (
        <List
          dataSource={conversations}
          renderItem={(conv) => {
            const hasUnread = parseInt(conv.unread_count) > 0
            const stateConfig = STATE_CONFIG[conv.state] ?? { label: conv.state, color: 'default' }

            return (
              <List.Item
                key={conv.id}
                onClick={() => navigate(`/inbox/${conv.id}`)}
                style={{
                  cursor: 'pointer',
                  background: hasUnread ? '#f6ffed' : '#fff',
                  borderRadius: 8,
                  marginBottom: 8,
                  padding: '12px 16px',
                  border: `1px solid ${hasUnread ? '#b7eb8f' : '#f0f0f0'}`,
                  transition: 'all 0.15s',
                }}
              >
                <List.Item.Meta
                  avatar={
                    <Badge count={parseInt(conv.unread_count) || 0} size="small">
                      <Avatar icon={<UserOutlined />} style={{ background: '#1677ff' }} />
                    </Badge>
                  }
                  title={
                    <Space>
                      <Text strong={hasUnread}>
                        {conv.client_name ?? conv.client_wa_id}
                      </Text>
                      <Tag color={stateConfig.color} style={{ fontSize: 11 }}>
                        {stateConfig.label}
                      </Tag>
                      {conv.client_type && (
                        <Tag style={{ fontSize: 11 }}>{conv.client_type}</Tag>
                      )}
                    </Space>
                  }
                  description={
                    <Space direction="vertical" size={2} style={{ width: '100%' }}>
                      <Text
                        type="secondary"
                        ellipsis
                        style={{ fontSize: 13, maxWidth: 460, fontWeight: hasUnread ? 500 : 400 }}
                      >
                        {conv.last_message_direction === 'outbound' && (
                          <Text type="secondary" style={{ fontSize: 12 }}>You: </Text>
                        )}
                        {conv.last_message_body ?? 'No messages yet'}
                      </Text>
                      <Space size={4}>
                        <ClockCircleOutlined style={{ fontSize: 11, color: '#999' }} />
                        <Text type="secondary" style={{ fontSize: 11 }}>
                          {dayjs(conv.last_message_at).fromNow()}
                        </Text>
                        {conv.assigned_staff_name && (
                          <Text type="secondary" style={{ fontSize: 11 }}>
                            · Assigned to {conv.assigned_staff_name}
                          </Text>
                        )}
                      </Space>
                    </Space>
                  }
                />
              </List.Item>
            )
          }}
        />
      )}
    </div>
  )
}
