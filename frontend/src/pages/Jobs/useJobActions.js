/**
 * useJob / useJobActions — load one job and run its next actions.
 *
 * The backend decides WHAT can be done (lifecycle.nextActions: enabled, reason,
 * inputs); this file only maps an action key to the API call that does it, so
 * the request shapes live in one place. Every success invalidates all
 * job-related queries (job, board, lists, dashboard, inbox counts) and the page
 * stays put, showing the new next step.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getJob } from '../../api/jobs.js'
import { approveQuotation, updateQuotationStatus, resendQuotation, claimQuotation } from '../../api/quotations.js'
import {
  convertFromQuotation, recordPayment, sendProof, updateProofStatus, advanceStage, setHold, assignOrder,
} from '../../api/orders.js'
import { createPurchaseOrder } from '../../api/purchaseOrders.js'
import { createTicket, updateTicket } from '../../api/tickets.js'
import { actionError } from '../../api/adapt.js'
import { qk, useJobMutation } from '../../lib/queryKeys.js'
import { money } from '../../lib/format.js'

export function useJob(quotationId) {
  return useQuery({
    queryKey: qk.job(quotationId),
    queryFn: () => getJob(quotationId),
    enabled: !!quotationId,
    refetchInterval: 60_000,
  })
}

/** Drop empty values: the API's optional fields reject null / ''. */
function clean(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (typeof v === 'string' && !v.trim()) continue
    out[k] = typeof v === 'string' ? v.trim() : v
  }
  return out
}

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v))

/** "Start production now" ticked on the action → { estimatedCompletion? } for the API, else undefined. */
const startNow = (v) => (v.startProduction ? clean({ estimatedCompletion: v.estimatedCompletion }) : undefined)

/**
 * Perform one next action.
 * @param {object} job       the useJob() data
 * @param {object} action    a lifecycle.nextActions entry
 * @param {object} v         input values (from the action's inputs)
 * @param {object} ctx       { lineItems?, override?: { reason } }
 */
export function performAction(job, action, v = {}, ctx = {}) {
  const q = job.quotation
  const o = job.order
  switch (action.key) {
    case 'price_quote':
    case 'send_quote':
      return approveQuotation(q.id, ctx.lineItems ?? [])
    case 'resend_quote':
      return resendQuotation(q.id)
    case 'mark_accepted':
      return updateQuotationStatus(q.id, 'accepted')
    case 'accept_and_order':
      // The client said yes: mark the quote accepted and create the order — one call.
      return convertFromQuotation(q.id, clean({ accept: true, poNumber: v.poNumber, conversationId: q.conversation_id }))
    case 'mark_declined':
      return updateQuotationStatus(q.id, 'rejected')
    case 'revise_quote':
      return updateQuotationStatus(q.id, 'draft')
    case 'create_order':
      return convertFromQuotation(q.id, clean({ poNumber: v.poNumber, conversationId: q.conversation_id }))
    case 'record_po':
      return createPurchaseOrder(clean({ quotationId: q.id, poNumber: v.poNumber, amount: num(v.amount), notes: v.notes }))
    case 'record_deposit':
    case 'record_balance':
    case 'record_payment':
      return recordPayment(o.id, clean({
        type: v.type || (action.key === 'record_deposit' ? 'deposit' : 'balance'),
        amount: num(v.amount),
        notes: v.notes,
        startProduction: startNow(v),
      }))
    case 'send_proof':
      return sendProof(o.id, clean({ proofUrl: v.proofUrl, notes: v.notes }))
    case 'mark_proof_approved':
      return updateProofStatus(o.id, clean({ status: 'approved', notes: v.notes, startProduction: startNow(v) }))
    case 'mark_proof_revision':
      return updateProofStatus(o.id, clean({ status: 'revision_requested', notes: v.notes }))
    case 'start_production':
    case 'mark_ready':
    case 'mark_collected':
      return advanceStage(o.id, clean({
        notes: v.notes,
        estimatedCompletion: v.estimatedCompletion,
        deliveryType: action.key === 'mark_ready' ? (v.deliveryType || 'collection') : undefined,
        trackingNumber: v.deliveryType === 'delivery' ? v.trackingNumber : undefined,
        // Mark collected: the balance taken at the counter is recorded in the same step.
        payment: action.key === 'mark_collected' && num(v.balanceAmount) > 0 ? { amount: num(v.balanceAmount), type: 'balance' } : undefined,
        override: ctx.override,
      }))
    case 'open_ticket':
      return createTicket(clean({ clientId: q?.client_id ?? o?.client_id, orderId: o?.id, category: v.category, description: v.description }))
    case 'resolve_ticket':
      return updateTicket(action.ticketId, clean({ status: 'resolved', resolutionNote: v.resolutionNote }))
    case 'release_hold':
      return setHold(o.id, { isOnHold: false })
    default:
      return Promise.reject(new Error(`This step (${action.label ?? action.key}) can't be done from here yet.`))
  }
}

/** Confirmation shown after an action succeeds (the card then shows the new next step). */
export function successMessage(action, result, values = {}) {
  switch (action.key) {
    case 'price_quote':
    case 'send_quote':
      return result?.whatsappSent === false
        ? { type: 'warning', text: 'Quote approved, but the WhatsApp message did not go through. Send the PDF to the client yourself.' }
        : { type: 'success', text: 'Quote sent to the client on WhatsApp' }
    case 'resend_quote': return { type: 'success', text: 'Quote PDF queued to send again' }
    case 'mark_accepted': return { type: 'success', text: 'Quote marked accepted' }
    case 'accept_and_order': return { type: 'success', text: `Quote accepted — order ${result?.order?.reference ?? ''} created`.replace(/ +$/, '') }
    case 'mark_declined': return { type: 'success', text: 'Quote marked declined' }
    case 'revise_quote': return { type: 'success', text: 'Quote reopened for pricing' }
    case 'create_order': return { type: 'success', text: `Order ${result?.order?.reference ?? ''} created`.replace('  ', ' ') }
    case 'record_po': {
      const ref = result?.order?.reference
      return { type: 'success', text: ref ? `PO recorded — order ${ref} created` : 'Purchase order recorded' }
    }
    case 'record_deposit':
      return { type: 'success', text: `Deposit of ${money(values.amount)} recorded${result?.advanced ? ' — production started' : ''}` }
    case 'record_balance':
    case 'record_payment': return { type: 'success', text: `Payment of ${money(values.amount)} recorded` }
    case 'send_proof': return { type: 'success', text: 'Proof sent to the client on WhatsApp' }
    case 'mark_proof_approved':
      return { type: 'success', text: result?.order?.stage === 'in_production' ? 'Design approved — production started' : 'Design approved' }
    case 'mark_proof_revision': return { type: 'success', text: 'Changes requested on the proof' }
    case 'start_production': return { type: 'success', text: 'Production started' }
    case 'mark_ready': return { type: 'success', text: 'Marked ready' }
    case 'mark_collected': {
      const what = action.label === 'Mark delivered' ? 'delivered' : 'collected'
      return { type: 'success', text: `${result?.payment ? `Balance of ${money(result.payment.amount)} recorded — ` : ''}Marked ${what} — job complete` }
    }
    case 'open_ticket': return { type: 'success', text: 'Ticket opened' }
    case 'resolve_ticket': return { type: 'success', text: 'Ticket resolved — the client is notified' }
    case 'release_hold': return { type: 'success', text: 'Hold released' }
    default: return { type: 'success', text: 'Done' }
  }
}

/**
 * useJobActions(job) → { run(action, values, ctx) → Promise<{ ok, result?, error? }>, pendingKey }
 * `error` is actionError() output: { status, code, message, overridable, reasons }.
 */
export function useJobActions(job) {
  const [pendingKey, setPendingKey] = useState(null)
  const mutation = useJobMutation({
    mutationFn: ({ action, values, ctx }) => performAction(job, action, values, ctx),
  })

  const run = async (action, values = {}, ctx = {}) => {
    setPendingKey(action.key + (action.ticketId ? `:${action.ticketId}` : ''))
    try {
      const result = await mutation.mutateAsync({ action, values, ctx })
      return { ok: true, result, message: successMessage(action, result, values) }
    } catch (err) {
      return { ok: false, error: actionError(err) }
    } finally {
      setPendingKey(null)
    }
  }

  return { run, pendingKey }
}

/** Owner changes: assign the order, or claim the quotation before there is an order. */
export function useOwnerActions(job) {
  const assign = useJobMutation({ mutationFn: (staffId) => assignOrder(job.order.id, staffId) })
  const claim = useJobMutation({ mutationFn: () => claimQuotation(job.quotation.id) })
  return { assign, claim }
}
