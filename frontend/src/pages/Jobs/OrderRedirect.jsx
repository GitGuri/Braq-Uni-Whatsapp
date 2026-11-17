import { useEffect } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Button, Spin } from 'antd'
import { jobForOrder } from '../../api/jobs.js'
import ErrorState from '../../components/ErrorState.jsx'
import LegacyOrderView from './LegacyOrderView.jsx'

/**
 * Old order links (/orders/:id — bookmarks, emails) open the order's job page.
 * An order from before quotes and orders were linked has no job: it is shown
 * on its own (LegacyOrderView).
 */
export default function OrderRedirect() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { data, error, refetch } = useQuery({ queryKey: ['job-for-order', id], queryFn: () => jobForOrder(id), retry: false })

  useEffect(() => {
    if (data?.quotationId) navigate(`/jobs/${data.quotationId}?tab=order`, { replace: true })
  }, [data, navigate])

  if (error) {
    return (
      <section className="braq-panel">
        <ErrorState
          title="Could not open this order"
          error={error}
          onRetry={refetch}
          action={<Button onClick={() => navigate('/orders')}>Back to orders</Button>}
        />
      </section>
    )
  }
  if (data && !data.quotationId) return <LegacyOrderView orderId={id} />
  return <div style={{ textAlign: 'center', padding: 80 }}><Spin size="large" aria-label="Opening the job" /></div>
}
