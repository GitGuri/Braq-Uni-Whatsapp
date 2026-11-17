import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Input, Select, Segmented, Skeleton } from 'antd'
import { CheckCircleOutlined, SearchOutlined } from '@ant-design/icons'
import dayjs from 'dayjs'
import { listConversations } from '../../api/conversations.js'
import { qk } from '../../lib/queryKeys.js'
import { useUrlState } from '../../lib/useUrlState.js'
import { listTime, initial } from '../../lib/format.js'
import { useAuth } from '../../auth/AuthContext.jsx'
import { TERMINAL_JOB_STATES } from '../../lib/status.js'
import ErrorState from '../../components/ErrorState.jsx'
import StatusPill from '../../components/StatusPill.jsx'

/** Who wrote the last message: "You:", a colleague's name, "Bot:" — or nothing for the client. */
function lastPrefix(conv, me) {
  if (conv.last_message_direction !== 'outbound') return null
  const by = conv.last_message_sender
  if (by?.id && by.id === me) return 'You:'
  if (by?.name) return `${by.name.split(' ')[0]}:`
  return 'Bot:'
}

/** State pill: who is holding the conversation right now. */
function statePill(conv) {
  if (conv.is_open === false)                 return { label: 'Closed',     tone: '' }
  if (conv.state === 'awaiting_consultant')   return { label: 'Waiting',    tone: 'amber' }
  if (conv.state === 'consultant_active')     return { label: 'Consultant', tone: 'blue' }
  return { label: 'Bot', tone: '' }
}

export default function InboxList() {
  const navigate = useNavigate()
  const { staff } = useAuth() ?? {}
  const [f, set] = useUrlState({ view: 'waiting', open: 'true', q: '' })
  const [search, setSearch] = useState(f.q)
  useEffect(() => { setSearch(f.q) }, [f.q])
  useEffect(() => {
    if (search === f.q) return undefined
    const t = setTimeout(() => set({ q: search.trim() }), 300)
    return () => clearTimeout(t)
  }, [search]) // eslint-disable-line react-hooks/exhaustive-deps

  // Views: everyone waiting for a person · waiting for / assigned to me · being answered · everything open.
  const VIEWS = {
    waiting: { state: 'awaiting_consultant' },
    mine:    { assignedToMe: 'true' },
    active:  { state: 'consultant_active' },
    all:     {},
  }
  const view = VIEWS[f.view] ? f.view : 'waiting'
  const params = { ...VIEWS[view], isOpen: f.open, search: f.q || undefined, limit: 50 }

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: qk.conversations(params),
    queryFn: () => listConversations(params),
    refetchInterval: 15_000,
    placeholderData: (prev) => prev,
  })

  // The API filters by search; this also narrows the rows if an older API ignores it.
  const q = f.q.toLowerCase()
  const conversations = (data?.items ?? []).filter((c) => !q
    || c.client_name?.toLowerCase().includes(q) || c.client_wa_id?.includes(q) || c.last_message_body?.toLowerCase().includes(q))

  const segments = [
    { label: 'Waiting', value: 'waiting' },
    { label: <span title="Assigned to me">Mine</span>, value: 'mine' },
    { label: 'Active', value: 'active' },
    { label: 'All open', value: 'all' },
  ]

  const emptyText = f.q
    ? `No conversations match "${f.q}". Search by name, number or message.`
    : view === 'waiting'
      ? 'Nobody is waiting for a consultant. Clients who ask for a person will appear here.'
      : view === 'mine'
        ? 'No conversations are assigned to you. Take one over, or claim it, to make it yours.'
        : view === 'active'
          ? 'No conversations are being handled by a consultant. Open one from "All open" and take it over to reply.'
          : 'No conversations match this view. Try "All conversations" to include closed ones.'

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">Inbox</h1>
          <div className="braq-page-subtitle">WhatsApp conversations with clients. Reply to anyone waiting first.</div>
        </div>
        <Select
          value={f.open}
          aria-label="Which conversations to show"
          options={[
            { value: 'true', label: 'Open conversations' },
            { value: 'false', label: 'Closed conversations' },
            { value: 'all', label: 'All conversations' },
          ]}
          onChange={(v) => set({ open: v })}
          style={{ width: 200, maxWidth: '100%' }}
        />
      </div>

      <div className="braq-filter-bar" role="search" aria-label="Filter conversations">
        <Segmented options={segments} value={view} onChange={(v) => set({ view: v })} aria-label="Which conversations" style={{ flex: '0 1 420px' }} block />
        <Input
          prefix={<SearchOutlined style={{ color: 'var(--ink-3)' }} />}
          placeholder="Search name, number or message"
          aria-label="Search conversations"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          allowClear
          style={{ flex: '1 1 220px', maxWidth: 340 }}
        />
      </div>

      <section className="braq-panel" aria-label="Conversations" style={{ overflow: 'hidden' }}>
        {error ? (
          <ErrorState title="Could not load conversations" error={error} onRetry={refetch} />
        ) : isLoading ? (
          <div style={{ padding: 18 }}><Skeleton active avatar paragraph={{ rows: 2 }} /></div>
        ) : conversations.length === 0 ? (
          <div style={{ padding: '40px 24px', textAlign: 'center', color: 'var(--ink-2)' }}>
            <CheckCircleOutlined style={{ fontSize: 22, color: 'var(--good)', marginBottom: 8 }} />
            <div style={{ maxWidth: 420, margin: '0 auto' }}>{emptyText}</div>
          </div>
        ) : (
          conversations.map((conv) => {
            const unread = parseInt(conv.unread_count) || 0
            const hasUnread = unread > 0
            const pill = statePill(conv)
            const name = conv.client_name ?? conv.client_wa_id
            const meta = [conv.client_type, conv.assigned_staff_name && `Assigned to ${conv.assigned_staff_name}`].filter(Boolean)
            const prefix = lastPrefix(conv, staff?.id)
            const job = conv.latest_job && !TERMINAL_JOB_STATES.includes(conv.latest_job.state) ? conv.latest_job : null

            return (
              <button
                key={conv.id}
                type="button"
                className="braq-queue-row"
                onClick={() => navigate(`/inbox/${conv.id}`)}
                aria-label={`${name}${hasUnread ? `, ${unread} unread` : ''}, ${pill.label.toLowerCase()}`}
                style={{ alignItems: 'flex-start', gap: 12, padding: '12px 16px' }}
              >
                <span
                  className="braq-avatar"
                  aria-hidden="true"
                  style={{ width: 36, height: 36, fontSize: 14, background: 'var(--surface-3)', color: 'var(--ink)' }}
                >
                  {initial(conv.client_name)}
                </span>

                <span style={{ flex: 1, minWidth: 0, display: 'block' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                    <span style={{
                      fontWeight: hasUnread ? 700 : 600, color: 'var(--ink)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                    }}>
                      {name}
                    </span>
                    <span className={`braq-pill ${pill.tone}`} style={{ height: 20, fontSize: 11, padding: '0 8px', flexShrink: 0 }}>
                      {pill.label}
                    </span>
                    {job && <span style={{ flexShrink: 0 }}><StatusPill kind="job" value={job.state} size="sm" /></span>}
                  </span>
                  <span style={{
                    display: 'block', marginTop: 2, fontSize: 13,
                    color: hasUnread ? 'var(--ink)' : 'var(--ink-2)', fontWeight: hasUnread ? 500 : 400,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {conv.last_message_status === 'needs_template' && (
                      <span style={{ color: 'var(--thread)', fontWeight: 600 }} title="WhatsApp only allows an approved template outside 24 hours">Not delivered (needs a template) · </span>
                    )}
                    {prefix && <span style={{ color: 'var(--ink-3)' }}>{prefix} </span>}
                    {conv.last_message_body ?? 'No messages yet'}
                  </span>
                  {meta.length > 0 && (
                    <span style={{
                      display: 'block', marginTop: 2, fontSize: 12, color: 'var(--ink-3)', textTransform: 'capitalize',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {meta.join(' · ')}
                    </span>
                  )}
                </span>

                <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6, flexShrink: 0 }}>
                  <time
                    dateTime={conv.last_message_at}
                    title={conv.last_message_at ? dayjs(conv.last_message_at).format('D MMM YYYY, HH:mm') : undefined}
                    style={{ fontSize: 12, color: hasUnread ? 'var(--thread)' : 'var(--ink-3)', fontWeight: hasUnread ? 600 : 400 }}
                  >
                    {listTime(conv.last_message_at)}
                  </time>
                  {hasUnread && (
                    <span className="braq-pill red" style={{ height: 20, minWidth: 20, padding: '0 7px', justifyContent: 'center', fontSize: 11 }}>
                      {unread}
                    </span>
                  )}
                </span>
              </button>
            )
          })
        )}
      </section>
    </div>
  )
}
