import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { App, Modal, Form, Select, Button, Skeleton } from 'antd'
import { PlusOutlined, RightOutlined } from '@ant-design/icons'
import { listClients } from '../api/clients.js'
import { listJobs } from '../api/jobs.js'
import { convertFromQuotation } from '../api/orders.js'
import { actionError } from '../api/adapt.js'
import { qk, useJobMutation } from '../lib/queryKeys.js'
import { TERMINAL_JOB_STATES } from '../lib/status.js'
import { money } from '../lib/format.js'
import StatusPill from './StatusPill.jsx'
import { useStartQuote } from './ClientPanel.jsx'

/**
 * "New job" on the Jobs board: pick a client, then start a quote for them —
 * or, when they already accepted a quote, create its order right here.
 * (Replaces the old Orders page "New order" form.)
 */
export default function NewJobModal({ open, onClose }) {
  const navigate = useNavigate()
  const { message } = App.useApp()
  const [form] = Form.useForm()
  const [search, setSearch] = useState('')
  const [clientId, setClientId] = useState(null)
  const startQuote = useStartQuote()

  const clientsQ = useQuery({
    queryKey: qk.clients({ search, limit: 20, picker: true }),
    queryFn: () => listClients({ search: search || undefined, limit: 20 }),
    enabled: open,
    placeholderData: (prev) => prev,
  })
  const jobsQ = useQuery({
    queryKey: qk.jobs({ clientId, limit: 50, picker: true }),
    queryFn: () => listJobs({ clientId, limit: 50 }),
    enabled: open && !!clientId,
  })
  const createOrder = useJobMutation({ mutationFn: (quotationId) => convertFromQuotation(quotationId, {}) })

  const clients = clientsQ.data?.items ?? []
  const openJobs = (jobsQ.data?.items ?? []).filter((j) => !TERMINAL_JOB_STATES.includes(j.state))
  const accepted = openJobs.filter((j) => j.state === 'ACCEPTED')
  const others = openJobs.filter((j) => j.state !== 'ACCEPTED')

  const close = () => { form.resetFields(); setClientId(null); onClose() }
  const start = () => startQuote.mutate({ clientId, confirmed: true }, { onSuccess: close })
  const order = (job) => createOrder.mutate(job.quotation_id, {
    onSuccess: (res) => {
      message.success(`Order ${res?.order?.reference ?? ''} created`.replace(/ +$/, ''))
      close()
      navigate(`/jobs/${job.quotation_id}?tab=order`)
    },
    onError: (err) => message.error(actionError(err, 'The order was not created').message),
  })

  return (
    <Modal title="New job" open={open} onCancel={close} footer={null} width={560} destroyOnHidden>
      <p className="braq-muted" style={{ margin: '4px 0 14px' }}>
        Choose the client. Start a quote for them, or — if they already accepted a quote — create its order.
      </p>
      <Form form={form} layout="vertical" name="new-job" requiredMark={false}>
        <Form.Item name="clientId" label="Client" rules={[{ required: true, message: 'Choose a client' }]}>
          <Select
            showSearch
            filterOption={false}
            onSearch={setSearch}
            onChange={(v) => setClientId(v ?? null)}
            loading={clientsQ.isFetching}
            placeholder="Search by name or WhatsApp number"
            notFoundContent={clientsQ.isFetching ? 'Searching…' : 'No clients match'}
            options={clients.map((c) => ({ value: c.id, label: `${c.name ?? c.whatsapp_number} (${c.whatsapp_number})` }))}
          />
        </Form.Item>
      </Form>

      {clientId && (
        jobsQ.isLoading ? <Skeleton active title={false} paragraph={{ rows: 2 }} /> : (
          <div className="braq-new-job">
            {accepted.length > 0 && (
              <>
                <div className="braq-section-label">Accepted quotes — create the order</div>
                <ul className="braq-list flush compact" aria-label="Accepted quotes">
                  {accepted.map((j) => (
                    <li key={j.quotation_id} className="braq-new-job-row">
                      <span style={{ minWidth: 0, flex: 1 }}>
                        <span className="braq-ref">{j.quotation_reference}</span> <span className="braq-small">{money(j.total)}</span>
                      </span>
                      <Button type="primary" size="small" loading={createOrder.isPending && createOrder.variables === j.quotation_id} onClick={() => order(j)}>
                        Create order
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}
            {others.length > 0 && (
              <>
                <div className="braq-section-label">Already open for this client</div>
                <ul className="braq-list flush compact" aria-label="Open jobs">
                  {others.map((j) => (
                    <li key={j.quotation_id}>
                      <Link to={`/jobs/${j.quotation_id}`} className="braq-row-link" onClick={close}>
                        <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', flex: 1, minWidth: 0 }}>
                          <span className="braq-ref">{j.order_reference ?? j.quotation_reference}</span>
                          <StatusPill kind="job" value={j.state} size="sm" />
                        </span>
                        <RightOutlined aria-hidden="true" className="braq-row-chevron" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )
      )}

      <div className="braq-modal-footer">
        <Button onClick={close}>Cancel</Button>
        <Button type="primary" icon={<PlusOutlined />} disabled={!clientId} loading={startQuote.isPending} onClick={start}>
          Start a new quote
        </Button>
      </div>
    </Modal>
  )
}
