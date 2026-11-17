/**
 * useMeta() — GET /api/meta: the lifecycle vocabulary (stages, job states,
 * statuses, bot states), business numbers (VAT, deposit) and the caller's
 * permissions. Defined once in the backend; the static values below are only a
 * fallback for the first paint or when the call fails.
 */
import { useQuery } from '@tanstack/react-query'
import { getMeta } from '../api/meta.js'
import { qk } from './queryKeys.js'
import { STAGES, LEGACY_STAGES } from './stages.js'

const L = (pairs) => pairs.map(([key, label]) => ({ key, label }))

export const FALLBACK_META = Object.freeze({
  stages: STAGES,
  legacyStages: LEGACY_STAGES,
  jobStates: [
    { key: 'PRICING',          label: 'Pricing',          description: 'Quote needs pricing and sending' },
    { key: 'QUOTED',           label: 'Quoted',           description: 'Quote sent — waiting for the client' },
    { key: 'EXPIRED',          label: 'Expired',          description: 'Quote lapsed before the client accepted' },
    { key: 'DECLINED',         label: 'Declined',         description: 'The client declined the quote' },
    { key: 'ACCEPTED',         label: 'Accepted',         description: 'The client accepted the quote — create the order' },
    { key: 'AWAITING_DEPOSIT', label: 'Awaiting deposit', description: 'Order created — waiting for the deposit' },
    { key: 'AWAITING_PROOF',   label: 'Proof',            description: 'Design proof is with the client' },
    { key: 'READY_TO_PRODUCE', label: 'Ready to produce', description: 'Nothing blocks production — set a due date and start' },
    { key: 'IN_PRODUCTION',    label: 'In production',    description: 'Being made, branded and checked' },
    { key: 'READY',            label: 'Ready',            description: 'Ready for collection or dispatched' },
    { key: 'COMPLETED',        label: 'Completed',        description: 'Collected or delivered' },
    { key: 'AFTER_SALES',      label: 'After-sales',      description: 'Completed with an open ticket' },
    { key: 'CANCELLED',        label: 'Cancelled',        description: 'The order was cancelled' },
  ],
  jobJourney: ['PRICING', 'QUOTED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'AWAITING_PROOF', 'READY_TO_PRODUCE', 'IN_PRODUCTION', 'READY', 'COMPLETED'],
  jobFlags: L([['ON_HOLD', 'On hold'], ['WITH_CONSULTANT', 'Client waiting'], ['OVERDUE', 'Overdue'], ['BALANCE_DUE', 'Balance due'], ['UNASSIGNED', 'Unassigned']]),
  jobQueues: [
    { key: 'accepted',    label: 'Client accepted — create order', hint: 'The client said yes — create the order' },
    { key: 'pricing',     label: 'Needs pricing',                  hint: 'Price the quote and send it' },
    { key: 'follow_up',   label: 'Quoted — follow up',             hint: 'Sent over 3 days ago, or expiring within 5 days' },
    { key: 'deposit',     label: 'Awaiting deposit',               hint: 'Order created — chase the deposit' },
    { key: 'proof',       label: 'Proof waiting',                  hint: 'Waiting on the client to approve the design' },
    { key: 'produce',     label: 'Ready to produce',               hint: 'Set a due date and start production' },
    { key: 'due_soon',    label: 'Due soon',                       hint: 'In production, due within 3 days' },
    { key: 'ready',       label: 'Ready — balance owed',           hint: 'Collect the balance when the client collects' },
    { key: 'after_sales', label: 'After-sales',                    hint: 'Completed jobs with an open ticket' },
  ],
  quotationStatuses: L([['draft', 'Pricing'], ['sent', 'Sent'], ['accepted', 'Accepted'], ['rejected', 'Declined'], ['expired', 'Expired']]),
  paymentStatuses: L([['unpaid', 'Unpaid'], ['deposit_paid', 'Deposit paid'], ['paid_in_full', 'Paid in full'],
    ['deposit_required', 'Deposit required'], ['not_required', 'No payment required']]),
  paymentTypes: ['deposit', 'balance', 'full'],
  proofStatuses: L([['none', 'No proof'], ['sent', 'Awaiting approval'], ['approved', 'Approved'], ['revision_requested', 'Changes requested']]),
  ticketStatuses: L([['open', 'Open'], ['in_progress', 'In progress'], ['resolved', 'Resolved'], ['closed', 'Closed']]),
  ticketCategories: L([['wrong_item', 'Wrong item'], ['defective', 'Defective item'], ['missing_item', 'Missing item'],
    ['account_query', 'Account query'], ['other', 'Other']]),
  clientTypes: ['retail', 'school', 'corporate', 'hospitality', 'church', 'security', 'government', 'reseller'],
  productCategories: ['school_wear', 'knitwear', 'medical_wear', 'outdoor_wear', 'corporate_wear', 'safety_wear'],
  // Unknown until /api/meta answers: treat every non-human state as "the bot has it".
  botStates: [],
  humanStates: ['awaiting_consultant', 'consultant_active'],
  currency: 'ZAR',
  vatRate: 0.15,
  vatPercent: 15,
  depositPercent: 60,
  quoteValidityDays: 30,
  ticketSlaHours: 4,
  permissions: null, // null = not loaded yet (useCan falls back to the role map)
  role: null,
})

/** Merge an API meta payload over the fallback (missing keys keep their fallback). */
export function mergeMeta(data) {
  if (!data || typeof data !== 'object') return FALLBACK_META
  const out = { ...FALLBACK_META }
  for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null) out[k] = v
  return out
}

export function useMeta() {
  const { data, isSuccess } = useQuery({
    queryKey: qk.meta,
    queryFn: getMeta,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
    retry: 1,
  })
  const meta = isSuccess ? mergeMeta(data) : FALLBACK_META
  return meta
}

export default useMeta
