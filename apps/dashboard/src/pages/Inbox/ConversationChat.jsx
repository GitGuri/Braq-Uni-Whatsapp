import { useState, useEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Card, Typography, Button, Input, Space, Tag, Spin, Alert, Tooltip,
  Avatar, Divider, Select, message as antMessage, Popconfirm,
} from 'antd'
import {
  ArrowLeftOutlined, SendOutlined, UserOutlined, RobotOutlined,
  CheckCircleOutlined, SwapOutlined, CloseCircleOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  getConversation, replyToConversation, takeoverConversation,
  handbackConversation, closeConversation, markConversationRead, assignConversation,
} from '../../api/conversations.js'
import { listStaff } from '../../api/staff.js'

const { Title, Text } = Typography

const BOT_STATES = new Set([
  'new', 'main_menu',
  'retail_menu', 'retail_pricing', 'retail_school_info', 'retail_school_select',
  'retail_hours', 'retail_layby', 'retail_collection',
  'corporate_menu', 'corporate_new_order', 'corporate_repeat_order',
  'corporate_uniform_garment', 'corporate_uniform_sizes', 'corporate_uniform_branding', 'corporate_uniform_quantity',
  'corporate_manufacturing_update', 'corporate_delivery_schedule',
  'corporate_po_quotation_ref', 'corporate_po_number', 'corporate_design_approval',
  'quotation_requested', 'quotation_gathering',
  'ticket_category', 'ticket_description',
  'registration_name', 'registration_org_or_school', 'registration_address',
  'order_tracking', 'branding_enquiry', 'store_info',
])

const STATE_LABELS = {
  awaiting_consultant:           'Waiting for consultant',
  consultant_active:             'Consultant active',
  new:                           'New conversation',
  main_menu:                     'Bot — Main menu',
  retail_menu:                   'Bot — Retail menu',
  retail_pricing:                'Bot — Retail pricing',
  retail_school_info:            'Bot — School info',
  retail_school_select:          'Bot — School selection',
  retail_hours:                  'Bot — Trading hours',
  retail_layby:                  'Bot — Lay-by info',
  retail_collection:             'Bot — Collection tracking',
  corporate_menu:                'Bot — Corporate menu',
  corporate_new_order:           'Bot — New order',
  corporate_repeat_order:        'Bot — Repeat order',
  corporate_manufacturing_update:'Bot — Mfg update',
  corporate_delivery_schedule:   'Bot — Delivery schedule',
  corporate_uniform_garment:     'Bot — Uniform (garment)',
  corporate_uniform_sizes:       'Bot — Uniform (sizes)',
  corporate_uniform_branding:    'Bot — Uniform (branding)',
  corporate_uniform_quantity:    'Bot — Uniform (quantity)',
  corporate_po_quotation_ref:    'Bot — PO (quotation ref)',
  corporate_po_number:           'Bot — PO (number)',
  corporate_design_approval:     'Bot — Design approval',
  quotation_requested:           'Bot — Quotation gathering',
  quotation_gathering:           'Bot — Quotation gathering',
  ticket_category:               'Bot — Support ticket (category)',
  ticket_description:            'Bot — Support ticket (details)',
  registration_name:             'Bot — Registration (name)',
  registration_org_or_school:    'Bot — Registration (school/org)',
  registration_address:          'Bot — Registration (address)',
  order_tracking:                'Bot — Order tracking',
  branding_enquiry:              'Bot — Branding enquiry',
  store_info:                    'Bot — Store info',
}

export default function ConversationChat() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [replyText, setReplyText] = useState('')
  const bottomRef = useRef(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => getConversation(id),
    refetchInterval: 10_000,
  })

  const { data: staffData } = useQuery({
    queryKey: ['staff-list'],
    queryFn: listStaff,
  })

  // Mark messages read on open
  useEffect(() => {
    if (data) markConversationRead(id).catch(() => {})
  }, [id, data])

  // Scroll to bottom when messages load/update
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [data?.messages])

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['conversation', id] })
    qc.invalidateQueries({ queryKey: ['conversations'] })
    qc.invalidateQueries({ queryKey: ['unread-count'] })
  }

  const replyMutation = useMutation({
    mutationFn: () => replyToConversation(id, replyText),
    onSuccess: () => { setReplyText(''); invalidate() },
    onError: (err) => antMessage.error(err.response?.data?.error ?? 'Failed to send message'),
  })

  const takeoverMutation = useMutation({
    mutationFn: () => takeoverConversation(id),
    onSuccess: () => { antMessage.success('You\'ve taken over this conversation'); invalidate() },
    onError: (err) => antMessage.error(err.response?.data?.error ?? 'Failed'),
  })

  const handbackMutation = useMutation({
    mutationFn: () => handbackConversation(id),
    onSuccess: () => { antMessage.success('Handed back to bot'); invalidate() },
    onError: (err) => antMessage.error(err.response?.data?.error ?? 'Failed'),
  })

  const closeMutation = useMutation({
    mutationFn: () => closeConversation(id),
    onSuccess: () => { antMessage.success('Conversation closed'); navigate('/inbox') },
    onError: (err) => antMessage.error(err.response?.data?.error ?? 'Failed'),
  })

  const assignMutation = useMutation({
    mutationFn: (staffId) => assignConversation(id, staffId),
    onSuccess: () => { antMessage.success('Assigned'); invalidate() },
    onError: (err) => antMessage.error(err.response?.data?.error ?? 'Failed'),
  })

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && replyText.trim()) {
      e.preventDefault()
      replyMutation.mutate()
    }
  }

  if (isLoading) return <Spin size="large" style={{ display: 'block', marginTop: 80 }} />
  if (error) return <Alert type="error" message="Failed to load conversation" />

  const { conversation: conv, messages } = data
  const staffList = staffData?.staff ?? []
  const isHandledByBot = BOT_STATES.has(conv.state)
  const isWaiting = conv.state === 'awaiting_consultant'
  const isActive = conv.state === 'consultant_active'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 112px)' }}>
      {/* Header */}
      <Card
        size="small"
        style={{ marginBottom: 8, flexShrink: 0 }}
        bodyStyle={{ padding: '10px 16px' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <Space>
            <Button
              size="small"
              icon={<ArrowLeftOutlined />}
              onClick={() => navigate('/inbox')}
            />
            <Avatar icon={<UserOutlined />} size="small" style={{ background: '#1677ff' }} />
            <div>
              <Text strong>{conv.client_name ?? conv.client_wa_id}</Text>
              <Text type="secondary" style={{ marginLeft: 8, fontSize: 12 }}>
                {conv.client_wa_id}
              </Text>
            </div>
            <Tag color={isWaiting ? 'warning' : isActive ? 'processing' : 'default'} style={{ marginLeft: 4 }}>
              {STATE_LABELS[conv.state] ?? conv.state}
            </Tag>
          </Space>

          <Space wrap>
            <Select
              placeholder="Assign to..."
              size="small"
              style={{ width: 180 }}
              value={conv.assigned_staff_id ?? undefined}
              options={staffList.map((s) => ({ value: s.id, label: s.name }))}
              onChange={(v) => assignMutation.mutate(v)}
              allowClear
            />

            {(isWaiting || isHandledByBot) && (
              <Button
                size="small"
                type="primary"
                icon={<CheckCircleOutlined />}
                onClick={() => takeoverMutation.mutate()}
                loading={takeoverMutation.isPending}
              >
                Take over
              </Button>
            )}

            {isActive && (
              <Popconfirm
                title="Hand back to bot?"
                description="Client will be sent a message and the bot resumes."
                onConfirm={() => handbackMutation.mutate()}
                okText="Yes, hand back"
              >
                <Button
                  size="small"
                  icon={<SwapOutlined />}
                  loading={handbackMutation.isPending}
                >
                  Hand back to bot
                </Button>
              </Popconfirm>
            )}

            <Popconfirm
              title="Close this conversation?"
              onConfirm={() => closeMutation.mutate()}
              okText="Close"
              okButtonProps={{ danger: true }}
            >
              <Button
                size="small"
                danger
                icon={<CloseCircleOutlined />}
                loading={closeMutation.isPending}
              >
                Close
              </Button>
            </Popconfirm>
          </Space>
        </div>
      </Card>

      {/* Message thread */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 0',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: '#444', marginTop: 40, fontSize: 13 }}>
            No messages yet
          </div>
        )}

        {messages.map((msg, i) => {
          const isOutbound = msg.direction === 'outbound'
          const showDateDivider =
            i === 0 ||
            !dayjs(msg.sent_at).isSame(dayjs(messages[i - 1].sent_at), 'day')

          return (
            <div key={msg.id}>
              {showDateDivider && (
                <Divider plain style={{ fontSize: 12, color: '#999', margin: '8px 0' }}>
                  {dayjs(msg.sent_at).format('dddd, DD MMM YYYY')}
                </Divider>
              )}

              <div
                style={{
                  display: 'flex',
                  justifyContent: isOutbound ? 'flex-end' : 'flex-start',
                  padding: '2px 16px',
                }}
              >
                {!isOutbound && (
                  <Avatar
                    icon={<UserOutlined />}
                    size={28}
                    style={{ background: '#1677ff', flexShrink: 0, marginRight: 8, alignSelf: 'flex-end' }}
                  />
                )}

                <div style={{ maxWidth: '65%' }}>
                  <div
                    style={{
                      background: isOutbound ? '#c0392b' : '#1e1e1e',
                      color: '#e8e8e8',
                      border: isOutbound ? 'none' : '1px solid #2a2a2a',
                      borderRadius: isOutbound ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      padding: '8px 12px',
                      fontSize: 14,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    }}
                  >
                    {msg.body}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#555',
                      marginTop: 2,
                      textAlign: isOutbound ? 'right' : 'left',
                      paddingLeft: isOutbound ? 0 : 4,
                      paddingRight: isOutbound ? 4 : 0,
                    }}
                  >
                    {dayjs(msg.sent_at).format('HH:mm')}
                    {isOutbound && <span style={{ marginLeft: 4 }}>✓✓</span>}
                  </div>
                </div>

                {isOutbound && (
                  <Avatar
                    icon={<RobotOutlined />}
                    size={28}
                    style={{ background: '#52c41a', flexShrink: 0, marginLeft: 8, alignSelf: 'flex-end' }}
                  />
                )}
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Reply input */}
      <Card
        size="small"
        style={{ flexShrink: 0, marginTop: 8 }}
        bodyStyle={{ padding: '10px 16px' }}
      >
        {!conv.is_open ? (
          <Alert type="info" message="This conversation is closed." showIcon />
        ) : isHandledByBot && !isWaiting ? (
          <Alert
            type="warning"
            showIcon
            message="Bot is currently handling this conversation."
            description={
              <Button
                size="small"
                type="primary"
                style={{ marginTop: 6 }}
                onClick={() => takeoverMutation.mutate()}
                loading={takeoverMutation.isPending}
              >
                Take over to reply
              </Button>
            }
          />
        ) : (
          <Space.Compact style={{ width: '100%' }}>
            <Input.TextArea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message… (Enter to send, Shift+Enter for new line)"
              autoSize={{ minRows: 1, maxRows: 5 }}
              style={{ borderRadius: '8px 0 0 8px' }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => replyMutation.mutate()}
              loading={replyMutation.isPending}
              disabled={!replyText.trim()}
              style={{ height: 'auto', borderRadius: '0 8px 8px 0' }}
            >
              Send
            </Button>
          </Space.Compact>
        )}
      </Card>
    </div>
  )
}
