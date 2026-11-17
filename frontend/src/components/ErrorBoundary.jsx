import { Component } from 'react'
import { Button } from 'antd'
import { WarningOutlined, ReloadOutlined } from '@ant-design/icons'

/** A page's code could not be downloaded — usually the dashboard was updated since this tab opened. */
const isChunkLoadError = (error) =>
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|ChunkLoadError|Loading chunk [\w-]+ failed/i
    .test(`${error?.name ?? ''} ${error?.message ?? ''}`)

/**
 * Catches a crash while rendering, so one broken page does not blank the whole
 * dashboard. Shows a friendly message and a "Reload" button.
 *
 *   <ErrorBoundary key={location.pathname}>…</ErrorBoundary>   // navigating away recovers
 *   <ErrorBoundary fullPage>…</ErrorBoundary>                    // around the whole app
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // eslint-disable-next-line no-console
    console.error('Dashboard error', error, info?.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const chunk = isChunkLoadError(error)
    const box = (
      <div className="braq-empty braq-error" role="alert">
        <span className="braq-empty-icon" aria-hidden="true"><WarningOutlined /></span>
        <div className="braq-empty-title">
          {chunk ? 'The dashboard has been updated' : 'Something went wrong on this page'}
        </div>
        <div className="braq-empty-text">
          {chunk
            ? 'Reload to get the latest version. Nothing you saved is lost.'
            : 'Reload the page to try again. If it keeps happening, tell an admin what you were doing.'}
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap' }}>
          <Button type="primary" icon={<ReloadOutlined />} onClick={() => window.location.reload()}>Reload</Button>
        </div>
      </div>
    )
    if (!this.props.fullPage) return <section className="braq-panel">{box}</section>
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'var(--paper)' }}>
        <section className="braq-panel" style={{ maxWidth: 520, width: '100%' }}>{box}</section>
      </div>
    )
  }
}
