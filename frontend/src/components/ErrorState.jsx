import { Button } from 'antd'
import { WarningOutlined, ReloadOutlined } from '@ant-design/icons'
import { errorMessage } from '../utils/errorMessage.js'

/**
 * Something failed to load — say what, show the server's reason, offer a retry.
 *   <ErrorState title="Could not load this job" error={error} onRetry={refetch} />
 */
export default function ErrorState({ title = 'Something went wrong', error, children, onRetry, action }) {
  const status = error?.response?.status
  const detail = error
    ? (status === 404 ? 'It may have been removed, or the link is wrong.' : errorMessage(error, 'Check your connection and try again.'))
    : null
  return (
    <div className="braq-empty braq-error" role="alert">
      <span className="braq-empty-icon" aria-hidden="true"><WarningOutlined /></span>
      <div className="braq-empty-title">{title}</div>
      {(detail || children) && <div className="braq-empty-text">{children ?? detail}</div>}
      {(onRetry || action) && (
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          {onRetry && <Button icon={<ReloadOutlined />} onClick={() => onRetry()}>Try again</Button>}
          {action}
        </div>
      )}
    </div>
  )
}
