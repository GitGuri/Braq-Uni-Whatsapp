import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Table, Card, Empty } from 'antd'
import { listPurchaseOrders } from '../../api/purchaseOrders.js'
import { pagedTotal } from '../../utils/pagination.js'
import { qk } from '../../lib/queryKeys.js'
import { useCan } from '../../lib/useCan.js'
import { money, date } from '../../lib/format.js'
import NoAccess from '../../components/NoAccess.jsx'

const PAGE_SIZE = 20

const PO_STATUSES = [
  { value: 'pending_review', label: 'Pending review', tone: 'amber' },
  { value: 'valid',          label: 'Valid',          tone: 'green' },
  { value: 'invalid',        label: 'Invalid',        tone: 'red' },
]

const muted = (v = '—') => <span style={{ color: 'var(--ink-3)' }}>{v}</span>

/**
 * Admin: the purchase-order log — every PO number recorded, for the record.
 * A PO is recorded on the job, with "Create order" (its Purchase order number
 * field); each row opens that job.
 */
export default function PurchaseOrdersList() {
  const allowed = useCan()('po.create')
  if (!allowed) return <NoAccess title="Purchase orders" />
  return <PurchaseOrderLog />
}

function PurchaseOrderLog() {
  const navigate = useNavigate()
  const [page, setPage] = useState(1)

  const { data, isLoading, isFetching } = useQuery({
    queryKey: qk.purchaseOrders({ page }),
    queryFn: () => listPurchaseOrders({ page, limit: PAGE_SIZE }),
    placeholderData: (prev) => prev,
  })
  const pos = data?.items ?? []
  const total = pagedTotal(data, pos, page, PAGE_SIZE)

  const columns = [
    { title: 'PO number', dataIndex: 'po_number', render: (v) => <span className="braq-ref">{v}</span> },
    {
      title: 'Job',
      key: 'job',
      render: (_, row) => (
        <Link to={`/jobs/${row.quotation_id}`} onClick={(e) => e.stopPropagation()} className="braq-ref">
          {row.order_reference ?? row.quotation_reference ?? 'Open job'}
        </Link>
      ),
    },
    { title: 'Client', key: 'client', render: (_, row) => row.client_name ?? muted() },
    {
      title: 'Amount',
      key: 'amount',
      align: 'right',
      // amount = the quotation total (listPurchaseOrders aliases q.total AS amount)
      render: (_, row) => {
        const v = row.amount ?? row.quotation_total
        return v != null ? <span style={{ whiteSpace: 'nowrap' }}>{money(v)}</span> : muted()
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      render: (s) => {
        const st = PO_STATUSES.find((x) => x.value === s)
        return <span className={`braq-pill ${st?.tone ?? ''}`}>{st?.label ?? s ?? '—'}</span>
      },
    },
    { title: 'Recorded by', dataIndex: 'validated_by_name', render: (v) => v ?? muted() },
    { title: 'Notes', dataIndex: 'notes', ellipsis: true, render: (v) => v || muted() },
    { title: 'Received', dataIndex: 'created_at', render: (v) => <span style={{ color: 'var(--ink-2)', whiteSpace: 'nowrap' }}>{date(v)}</span> },
  ]

  return (
    <div>
      <div className="braq-page-header">
        <div>
          <h1 className="braq-page-title">Purchase orders</h1>
          <div className="braq-page-subtitle">A log of every purchase order number recorded. To record one, open the job and enter it when you create the order.</div>
        </div>
      </div>

      <Card styles={{ body: { padding: 0 } }}>
        <Table
          dataSource={pos}
          columns={columns}
          rowKey="id"
          loading={isLoading || isFetching}
          size="middle"
          pagination={{ current: page, pageSize: PAGE_SIZE, total, onChange: setPage, showSizeChanger: false }}
          scroll={{ x: 'max-content' }}
          onRow={(row) => ({ onClick: () => navigate(`/jobs/${row.quotation_id}`), style: { cursor: 'pointer' } })}
          locale={{
            emptyText: isLoading ? ' ' : (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No purchase orders yet. They appear here when an order is created with a PO number." />
            ),
          }}
        />
      </Card>
    </div>
  )
}
