/**
 * Query keys in one place, plus mutation helpers that invalidate everything a
 * change can touch — a payment changes the job, the order, the board, the lists
 * and the dashboard numbers at once, so they all refetch together.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query'

export const qk = {
  meta:           ['meta'],
  jobs:           (params) => (params ? ['jobs', params] : ['jobs']),
  job:            (id) => ['job', id],
  orders:         (params) => (params ? ['orders', params] : ['orders']),
  order:          (id) => ['order', id],
  orderSizes:     (id) => ['order-sizes', id],
  quotations:     (params) => (params ? ['quotations', params] : ['quotations']),
  quotation:      (id) => ['quotation', id],
  clients:        (params) => (params ? ['clients', params] : ['clients']),
  client:         (id) => ['client', id],
  tickets:        (params) => (params ? ['tickets', params] : ['tickets']),
  ticket:         (id) => ['ticket', id],
  conversations:  (params) => (params ? ['conversations', params] : ['conversations']),
  conversation:   (id) => ['conversation', id],
  clientConversation: (clientId) => ['conversations', 'client', clientId],
  purchaseOrders: (params) => (params ? ['purchase-orders', params] : ['purchase-orders']),
  products:       (params) => (params ? ['products', params] : ['products']),
  staff:          ['staff-list'],
  kpis:           ['dashboard-kpis'],
  unread:         ['unread-count'],
}

/** Every key a job-level change can affect (prefix match). */
const JOB_RELATED = [
  ['job'], ['jobs'], ['orders'], ['order'], ['order-sizes'], ['quotations'], ['quotation'],
  ['clients'], ['client'], ['tickets'], ['ticket'], ['purchase-orders'],
  ['dashboard-kpis'], ['unread-count'], ['conversations'], ['conversation'],
]

export function invalidateJobRelated(qc) {
  return Promise.all(JOB_RELATED.map((queryKey) => qc.invalidateQueries({ queryKey })))
}

/**
 * useMutation that, on success, invalidates every job-related query before the
 * caller's own onSuccess runs.
 */
export function useJobMutation({ mutationFn, onSuccess, onError, ...rest }) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn,
    ...rest,
    onSuccess: async (data, vars, ctx) => {
      await invalidateJobRelated(qc)
      return onSuccess?.(data, vars, ctx)
    },
    onError,
  })
}
