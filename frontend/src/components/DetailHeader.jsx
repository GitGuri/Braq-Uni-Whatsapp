import { Link } from 'react-router-dom'
import { ArrowLeftOutlined } from '@ant-design/icons'

/**
 * Detail-page header: back link, title, a row of pills / facts, actions.
 *   <DetailHeader back={{ to: '/jobs', label: 'Jobs' }} title="BRQ-Q-00012"
 *                 meta={<>…pills…</>} actions={<Button …/>} />
 */
export default function DetailHeader({ back, title, titleExtra, meta, actions }) {
  return (
    <>
      {back && (
        <Link to={back.to} className="braq-back" onClick={back.onClick}>
          <ArrowLeftOutlined aria-hidden="true" /> {back.label}
        </Link>
      )}
      <div className="braq-page-header" style={{ alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <h1 className="braq-page-title" style={{ overflowWrap: 'anywhere' }}>{title}</h1>
            {titleExtra}
          </div>
          {meta && <div className="braq-page-subtitle braq-detail-meta">{meta}</div>}
        </div>
        {actions && <div className="braq-page-actions">{actions}</div>}
      </div>
    </>
  )
}
