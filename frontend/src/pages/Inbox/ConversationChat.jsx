import { useState, useEffect, useLayoutEffect, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  App, Alert, Button, Input, Spin, Select, Popconfirm, Drawer,
} from 'antd'
import {
  ArrowLeftOutlined, SendOutlined, CheckCircleOutlined, SwapOutlined, CloseCircleOutlined, RobotOutlined, LockOutlined, IdcardOutlined, WarningOutlined,
} from '@ant-design/icons'
import dayjs from 'dayjs'
import {
  getConversation, replyToConversation, takeoverConversation,
  handbackConversation, closeConversation, markConversationRead, assignConversation,
} from '../../api/conversations.js'
import { listStaff, assignableStaff } from '../../api/staff.js'
import { errorMessage } from '../../utils/errorMessage.js'
import { qk } from '../../lib/queryKeys.js'
import { useMediaQuery } from '../../lib/useMediaQuery.js'
import { useMeta } from '../../lib/useMeta.js'
import { dayLabel, initial, sentence } from '../../lib/format.js'
import ClientPanel from '../../components/ClientPanel.jsx'
import ErrorState from '../../components/ErrorState.jsx'

/** Header label for the conversation's state; human states first, anything else is the bot's. */
function stateLabel(conv, meta) {
  if (!conv.is_open) return 'Closed'
  if (conv.state === 'awaiting_consultant') return 'Waiting for a consultant'
  if (conv.state === 'consultant_active') return 'Consultant replying'
  if ((meta.humanStates ?? []).includes(conv.state)) return sentence(conv.state)
  return `Bot: ${sentence(conv.state).toLowerCase()}`
}

/**
 * Who sent an outbound message: the staff member who wrote it (messages carry
 * sent_by_name), else the bot / an automatic message.
 */
function senderLabel(msg) {
  if (msg.sent_by_name) return { text: msg.sent_by_name, bot: false }
  return { text: 'Bot', bot: true }
}

/** Delivery problems shown under an outbound bubble (status from the outbox). */
const UNDELIVERED = {
  needs_template: {
    text: 'Not delivered: needs a WhatsApp template',
    hint: 'The client has not written in the last 24 hours, so WhatsApp only allows an approved template. Ask the client to message you, or ask an admin to set up the template.',
  },
  failed: {
    text: 'Not delivered',
    hint: 'WhatsApp did not accept this message. Try again, or contact the client another way.',
  },
}

/** One message bubble. New bubbles (sent or received while open) settle in once. */
function Bubble({ msg, animate, grouped }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    if (!animate || !ref.current?.animate) return
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    ref.current.animate(
      [{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }],
      { duration: 180, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const isOutbound = msg.direction === 'outbound'
  const sender = isOutbound ? senderLabel(msg) : null

  return (
    <div
      ref={ref}
      style={{
        display: 'flex', flexDirection: 'column',
        alignItems: isOutbound ? 'flex-end' : 'flex-start',
        marginTop: grouped ? 2 : 10,
      }}
    >
      <div
        style={{
          maxWidth: 'min(560px, 82%)',
          padding: '7px 11px',
          borderRadius: isOutbound ? '12px 12px 4px 12px' : '12px 12px 12px 4px',
          background: isOutbound ? (sender.bot ? 'var(--surface-3)' : 'var(--info-soft)') : 'var(--surface)',
          border: isOutbound ? '1px solid transparent' : '1px solid var(--line)',
          color: 'var(--ink)',
          fontSize: 14,
          lineHeight: 1.45,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {msg.body}
      </div>
      <div style={{ fontSize: 11, color: 'var(--ink-3)', marginTop: 3, padding: '0 4px', display: 'flex', alignItems: 'center', gap: 4 }}>
        {sender && (
          <>
            {sender.bot && <RobotOutlined aria-hidden="true" />}
            <span style={{ fontWeight: 600, color: 'var(--ink-2)' }}>{sender.text}</span>
            <span aria-hidden="true">·</span>
          </>
        )}
        <time dateTime={msg.sent_at}>{dayjs(msg.sent_at).format('HH:mm')}</time>
      </div>
      {isOutbound && UNDELIVERED[msg.status] && (
        <div className="braq-undelivered" role="status" title={UNDELIVERED[msg.status].hint}>
          <WarningOutlined aria-hidden="true" /> {UNDELIVERED[msg.status].text}
          <div className="braq-undelivered-hint">{UNDELIVERED[msg.status].hint}</div>
        </div>
      )}
    </div>
  )
}

export default function ConversationChat() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { message: antMessage } = App.useApp()
  const meta = useMeta()
  const [replyText, setReplyText] = useState('')
  const [clientOpen, setClientOpen] = useState(false)
  const wide = useMediaQuery('(min-width: 1200px)')
  const bottomRef = useRef(null)
  const seenRef = useRef(null) // message ids already on screen; null until the first load

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.conversation(id),
    queryFn: () => getConversation(id),
    refetchInterval: 10_000,
  })

  const { data: staffData } = useQuery({
    queryKey: qk.staff,
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

  // Remember which messages have been shown, so only later arrivals animate in
  useEffect(() => {
    if (data?.messages) seenRef.current = new Set(data.messages.map((m) => m.id))
  }, [data?.messages])

  // Conversation changes also move job flags (With consultant) — refresh those too.
  const invalidate = () => Promise.all([
    qc.invalidateQueries({ queryKey: qk.conversation(id) }),
    qc.invalidateQueries({ queryKey: qk.conversations() }),
    qc.invalidateQueries({ queryKey: qk.unread }),
    qc.invalidateQueries({ queryKey: qk.jobs() }),
    qc.invalidateQueries({ queryKey: ['job'] }),
  ])

  const replyMutation = useMutation({
    mutationFn: () => replyToConversation(id, replyText),
    onSuccess: () => { setReplyText(''); invalidate() },
    onError: (err) => antMessage.error(errorMessage(err, 'Your message was not sent. Try again.')),
  })

  const takeoverMutation = useMutation({
    mutationFn: () => takeoverConversation(id),
    onSuccess: () => { antMessage.success('You\'ve taken over this conversation'); invalidate() },
    onError: (err) => antMessage.error(errorMessage(err, 'Could not take over this conversation')),
  })

  const handbackMutation = useMutation({
    mutationFn: () => handbackConversation(id),
    onSuccess: () => { antMessage.success('Handed back to the bot'); invalidate() },
    onError: (err) => antMessage.error(errorMessage(err, 'Could not hand this conversation back to the bot')),
  })

  const closeMutation = useMutation({
    mutationFn: () => closeConversation(id),
    // Mark the inbox list, counts and job flags stale first, so the inbox opens on fresh data.
    onSuccess: () => { antMessage.success('Conversation closed'); invalidate(); navigate('/inbox') },
    onError: (err) => antMessage.error(errorMessage(err, 'Could not close this conversation')),
  })

  const assignMutation = useMutation({
    mutationFn: (staffId) => assignConversation(id, staffId),
    onSuccess: () => { antMessage.success('Assignment saved'); invalidate() },
    onError: (err) => antMessage.error(errorMessage(err, 'Could not change who this is assigned to')),
  })

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && replyText.trim()) {
      e.preventDefault()
      // One send at a time: Enter again while the last reply is on its way would send it twice.
      if (!replyMutation.isPending) replyMutation.mutate()
    }
  }

  if (isLoading) return <Spin size="large" style={{ display: 'block', marginTop: 80 }} />
  if (error) {
    return (
      <section className="braq-panel">
        <ErrorState title="Could not load this conversation" error={error} onRetry={refetch} action={<Button onClick={() => navigate('/inbox')}>Back to inbox</Button>} />
      </section>
    )
  }

  const { conversation: conv, messages } = data
  const staffList = staffData?.staff ?? []
  // States come from /api/meta: anything that isn't a human (consultant) state is the bot's.
  const isHuman = (meta.humanStates ?? []).includes(conv.state)
  const isHandledByBot = conv.is_open && !isHuman
  const isWaiting = conv.state === 'awaiting_consultant'
  const isActive = conv.state === 'consultant_active'
  const seen = seenRef.current
  // WhatsApp only takes free-form messages within 24 hours of the client's last message.
  const lastInbound = messages.reduce((t, m) => (m.direction === 'inbound' && m.sent_at && (!t || dayjs(m.sent_at).isAfter(t)) ? dayjs(m.sent_at) : t), null)
  const outsideWindow = !lastInbound || dayjs().diff(lastInbound, 'hour', true) >= 24

  const clientPanel = <ClientPanel clientId={conv.client_id} conversationId={conv.id} />

  return (
    <div className="braq-chat-layout">
    <section
      className="braq-panel braq-chat"
      aria-label={`Conversation with ${conv.client_name ?? conv.client_wa_id}`}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap',
          gap: 10, padding: '10px 14px', borderBottom: '1px solid var(--line)', flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: '1 1 260px' }}>
          <button type="button" className="braq-icon-btn" aria-label="Back to inbox" onClick={() => navigate('/inbox')}>
            <ArrowLeftOutlined />
          </button>
          <span className="braq-avatar" aria-hidden="true" style={{ background: 'var(--surface-3)', color: 'var(--ink)' }}>
            {initial(conv.client_name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 650, lineHeight: 1.25, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {conv.client_name ?? conv.client_wa_id}
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 2 }}>
              <span style={{ fontSize: 12, color: 'var(--ink-2)' }}>{conv.client_wa_id}</span>
              <span className={`braq-pill ${isWaiting ? 'amber' : isActive ? 'blue' : ''}`} style={{ height: 20, fontSize: 11, padding: '0 8px' }}>
                {stateLabel(conv, meta)}
              </span>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, flex: '1 1 auto', justifyContent: 'flex-end', minWidth: 0 }}>
          {!wide && (
            <Button size="small" icon={<IdcardOutlined />} onClick={() => setClientOpen(true)}>
              Client and jobs
            </Button>
          )}
          <Select
            placeholder="Assign to…"
            aria-label="Assign conversation to"
            size="small"
            style={{ flex: '1 1 120px', minWidth: 120, maxWidth: 190 }}
            value={conv.assigned_staff_id ?? undefined}
            options={assignableStaff(staffList, conv.assigned_staff_id).map((s) => ({ value: s.id, label: s.name }))}
            onChange={(v) => assignMutation.mutate(v)}
            allowClear
          />

          {/* Only while the bot has the chat: replying to a waiting chat takes it over already. */}
          {isHandledByBot && !isWaiting && (
            <Button
              size="small"
              icon={<CheckCircleOutlined />}
              onClick={() => takeoverMutation.mutate()}
              loading={takeoverMutation.isPending}
            >
              Take over
            </Button>
          )}

          {isActive && (
            <Popconfirm
              title="Hand back to the bot?"
              description="The client gets a message and the bot carries on from the main menu."
              onConfirm={() => handbackMutation.mutate()}
              okText="Hand back"
            >
              <Button size="small" icon={<SwapOutlined />} loading={handbackMutation.isPending}>
                Hand back to bot
              </Button>
            </Popconfirm>
          )}

          <Popconfirm
            title="Close this conversation?"
            description="It moves to your closed conversations."
            onConfirm={() => closeMutation.mutate()}
            okText="Close conversation"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<CloseCircleOutlined />} loading={closeMutation.isPending}>
              Close
            </Button>
          </Popconfirm>
        </div>
      </div>

      {/* Message thread */}
      <div
        role="log"
        aria-label="Messages"
        aria-live="polite"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '8px 14px 16px',
          background: 'var(--surface-2)',
        }}
      >
        {messages.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--ink-3)', marginTop: 40, fontSize: 13 }}>
            No messages yet. Anything the client sends on WhatsApp will appear here.
          </div>
        )}

        {messages.map((msg, i) => {
          const prev = messages[i - 1]
          const showDateDivider = i === 0 || !dayjs(msg.sent_at).isSame(dayjs(prev.sent_at), 'day')
          const grouped = !showDateDivider && prev.direction === msg.direction
            && dayjs(msg.sent_at).diff(dayjs(prev.sent_at), 'minute') < 5

          return (
            <div key={msg.id}>
              {showDateDivider && (
                <div role="separator" style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '14px 0 6px', color: 'var(--ink-3)', fontSize: 12 }}>
                  <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
                  <span>{dayLabel(msg.sent_at)}</span>
                  <span style={{ flex: 1, height: 1, background: 'var(--line)' }} />
                </div>
              )}
              <Bubble msg={msg} grouped={grouped} animate={!!seen && !seen.has(msg.id)} />
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>

      {/* Composer */}
      <div style={{ flexShrink: 0, padding: '10px 14px', borderTop: '1px solid var(--line)', background: 'var(--surface)' }}>
        {!conv.is_open ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-2)', fontSize: 13, padding: '4px 0' }}>
            <LockOutlined aria-hidden="true" /> This conversation is closed, so replies are turned off.
          </div>
        ) : isHandledByBot && !isWaiting ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--ink-2)', fontSize: 13 }}>
              <RobotOutlined aria-hidden="true" /> The bot is handling this conversation. Take it over to reply yourself.
            </span>
            <Button
              type="primary"
              icon={<CheckCircleOutlined />}
              onClick={() => takeoverMutation.mutate()}
              loading={takeoverMutation.isPending}
            >
              Take over to reply
            </Button>
          </div>
        ) : (
          <>
          {outsideWindow && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message="Outside WhatsApp's 24-hour window — this message will need an approved template and may not be delivered as typed."
            />
          )}
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8 }}>
            <Input.TextArea
              value={replyText}
              onChange={(e) => setReplyText(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write a reply. Enter sends, Shift+Enter adds a line."
              aria-label="Reply"
              autoSize={{ minRows: 1, maxRows: 5 }}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              icon={<SendOutlined />}
              onClick={() => { if (!replyMutation.isPending) replyMutation.mutate() }}
              loading={replyMutation.isPending}
              disabled={!replyText.trim()}
            >
              Send
            </Button>
          </div>
          </>
        )}
      </div>
    </section>
    {wide && <aside className="braq-chat-side" aria-label="Client">{clientPanel}</aside>}
    <Drawer
      open={clientOpen && !wide}
      onClose={() => setClientOpen(false)}
      placement="right"
      width="min(420px, 100vw)"
      title={conv.client_name ?? conv.client_wa_id}
      styles={{ body: { padding: 12, background: 'var(--paper)' } }}
    >
      {clientOpen && !wide && clientPanel}
    </Drawer>
    </div>
  )
}
