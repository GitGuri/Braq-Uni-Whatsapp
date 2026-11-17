import { useNavigate } from 'react-router-dom'
import { Button } from 'antd'
import { MessageOutlined } from '@ant-design/icons'
import { useMeta } from '../../lib/useMeta.js'
import { listTime, dateTime } from '../../lib/format.js'
import EmptyState from '../../components/EmptyState.jsx'

/** Who holds a conversation: closed / waiting / consultant / bot (states from /api/meta). */
export function conversationHolder(conv, meta) {
  if (!conv) return null
  if (conv.is_open === false) return { label: 'Closed', tone: '' }
  if (conv.state === 'awaiting_consultant') return { label: 'Waiting for a consultant', tone: 'amber' }
  if ((meta.humanStates ?? []).includes(conv.state)) return { label: 'Consultant replying', tone: 'blue' }
  return { label: 'Bot is handling it', tone: '' }
}

/**
 * The job's WhatsApp conversation: who holds it, what the client last said
 * (their last message, not ours) and the way into the chat.
 *   <ConversationPanel conversation={job.conversation} />
 */
export default function ConversationPanel({ conversation: conv, compact = false }) {
  const navigate = useNavigate()
  const meta = useMeta()
  const holder = conversationHolder(conv, meta)
  return (
    <section className="braq-panel" aria-labelledby="job-chat">
      <div className="braq-panel-head">
        <h2 id="job-chat" className="braq-panel-title">Conversation</h2>
        {holder && <span className={`braq-pill ${holder.tone}`}>{holder.label}</span>}
      </div>
      {!conv ? (
        <EmptyState compact title="No WhatsApp conversation">This client hasn&apos;t messaged Braq on WhatsApp yet.</EmptyState>
      ) : (
        <div className="braq-panel-body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {conv.last_inbound ? (
            <div className="braq-chat-preview in">
              <div className="braq-chat-preview-body">{conv.last_inbound.body || '(attachment)'}</div>
              <div className="braq-small">
                Client said · <time dateTime={conv.last_inbound.created_at} title={dateTime(conv.last_inbound.created_at)}>{listTime(conv.last_inbound.created_at)}</time>
                {conv.last_message?.direction === 'outbound' && ' · we replied'}
              </div>
            </div>
          ) : <p className="braq-muted" style={{ margin: 0 }}>The client hasn&apos;t written yet.</p>}
          {!compact && (
            <div className="braq-small">
              {conv.assigned_staff_name ? `Assigned to ${conv.assigned_staff_name}` : 'Not assigned'}
              {Number(conv.unread_count) > 0 && <> · <strong style={{ color: 'var(--thread)' }}>{conv.unread_count} unread</strong></>}
            </div>
          )}
          <Button icon={<MessageOutlined />} onClick={() => navigate(`/inbox/${conv.id}`)} style={{ alignSelf: 'flex-start' }}>
            Open chat
          </Button>
        </div>
      )}
    </section>
  )
}
