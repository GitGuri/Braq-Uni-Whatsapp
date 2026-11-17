import { useNavigate } from 'react-router-dom'
import { Button } from 'antd'
import { LockOutlined } from '@ant-design/icons'
import PageHeader from './PageHeader.jsx'

/**
 * A page the signed-in staff member's role does not open — said plainly,
 * instead of an empty page or a list of errors.
 *   if (!can('staff.manage')) return <NoAccess title="Staff" who="admins" />
 */
export default function NoAccess({ title, who = 'admins and managers', children }) {
  const navigate = useNavigate()
  return (
    <div>
      <PageHeader title={title} />
      <section className="braq-panel">
        <div className="braq-empty" role="status">
          <span className="braq-empty-icon" aria-hidden="true"><LockOutlined /></span>
          <div className="braq-empty-title">You don&apos;t have access to this page</div>
          <div className="braq-empty-text">{children ?? `It is for ${who}. Ask one of them if you need something here.`}</div>
          <div style={{ marginTop: 12 }}><Button onClick={() => navigate('/')}>Back to the dashboard</Button></div>
        </div>
      </section>
    </div>
  )
}
