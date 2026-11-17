/**
 * Status vocabulary for pills and filters. Labels come from GET /api/meta
 * (useMeta); tones (pill colours) are presentation and live here.
 *
 *   const status = useStatus()
 *   status.label('job', 'AWAITING_DEPOSIT')   // "Awaiting deposit"
 *   status.tone('payment', 'paid_in_full')    // "green"
 */
import { useMemo } from 'react'
import { useMeta } from './useMeta.js'
import { sentence } from './format.js'

// Pill tones: '' (neutral) | red | amber | green | blue — see .braq-pill in index.css.
export const TONES = {
  job: {
    PRICING: 'amber', QUOTED: 'blue', EXPIRED: '', DECLINED: 'red', ACCEPTED: 'green',
    AWAITING_DEPOSIT: 'amber', AWAITING_PROOF: 'blue', READY_TO_PRODUCE: 'green',
    IN_PRODUCTION: 'blue', READY: 'green', COMPLETED: '', AFTER_SALES: 'amber', CANCELLED: '',
  },
  flag: { ON_HOLD: 'amber', WITH_CONSULTANT: 'amber', OVERDUE: 'red', BALANCE_DUE: 'amber', UNASSIGNED: '' },
  quotation: { draft: 'amber', sent: 'blue', accepted: 'green', rejected: 'red', expired: '' },
  payment: { unpaid: '', deposit_required: '', deposit_paid: 'blue', paid_in_full: 'green', not_required: 'green' },
  proof: { none: '', sent: 'blue', approved: 'green', revision_requested: 'amber' },
  ticket: { open: 'blue', in_progress: 'amber', resolved: 'green', closed: '' },
  stage: { deposit_pending: 'amber', in_production: 'blue', ready: 'green', completed: '' },
  po: { pending_review: 'amber', valid: 'green', invalid: 'red' },
  conversation: { awaiting_consultant: 'amber', consultant_active: 'blue', closed: '', bot: '' },
}

/** Job states that need nothing more (never overdue, not in work queues). */
export const TERMINAL_JOB_STATES = ['COMPLETED', 'DECLINED', 'EXPIRED', 'CANCELLED']

/**
 * The journey bar: the job lifecycle as eight steps. Each step lists the job
 * states that sit on it (side states such as Declined sit on Quoted).
 */
export const JOURNEY_STEPS = [
  { key: 'pricing',    label: 'Pricing',    short: 'Price',   states: ['PRICING'] },
  { key: 'quoted',     label: 'Quoted',     short: 'Quote',   states: ['QUOTED', 'EXPIRED', 'DECLINED'] },
  { key: 'accepted',   label: 'Accepted',   short: 'Accept',  states: ['ACCEPTED'] },
  { key: 'deposit',    label: 'Deposit',    short: 'Deposit', states: ['AWAITING_DEPOSIT'] },
  { key: 'proof',      label: 'Proof',      short: 'Proof',   states: ['AWAITING_PROOF'] },
  { key: 'production', label: 'Production', short: 'Make',    states: ['READY_TO_PRODUCE', 'IN_PRODUCTION'] },
  { key: 'ready',      label: 'Ready',      short: 'Ready',   states: ['READY'] },
  { key: 'collected',  label: 'Collected',  short: 'Done',    states: ['COMPLETED', 'AFTER_SALES'] },
]

export const journeyIndex = (state) => Math.max(0, JOURNEY_STEPS.findIndex((s) => s.states.includes(state)))

const OWN_LABELS = {
  stage: null, // from meta.stages
  po: { pending_review: 'Pending review', valid: 'Valid', invalid: 'Invalid' },
  conversation: { awaiting_consultant: 'Waiting', consultant_active: 'Consultant', closed: 'Closed', bot: 'Bot' },
}

function index(list) {
  const out = {}
  for (const item of list ?? []) {
    if (typeof item === 'string') out[item] = sentence(item)
    else if (item?.key) out[item.key] = item.label ?? sentence(item.key)
  }
  return out
}

/** Labels per kind from a meta payload. */
export function labelsFrom(meta) {
  return {
    job: index(meta.jobStates),
    flag: index(meta.jobFlags),
    quotation: index(meta.quotationStatuses),
    payment: index(meta.paymentStatuses),
    proof: index(meta.proofStatuses),
    ticket: index(meta.ticketStatuses),
    category: index(meta.ticketCategories),
    stage: { ...index(meta.stages), ...Object.fromEntries(Object.entries(meta.legacyStages ?? {}).map(([legacy, to]) => [legacy, index(meta.stages)[to] ?? sentence(legacy)])) },
    po: OWN_LABELS.po,
    conversation: OWN_LABELS.conversation,
  }
}

/** { label(kind, value), tone(kind, value), description(state), options(kind) } fed by /api/meta. */
export function useStatus() {
  const meta = useMeta()
  return useMemo(() => {
    const labels = labelsFrom(meta)
    const descriptions = Object.fromEntries((meta.jobStates ?? []).map((s) => [s.key, s.description]))
    return {
      label: (kind, value) => labels[kind]?.[value] ?? sentence(value ?? '—'),
      tone: (kind, value) => TONES[kind]?.[kind === 'stage' ? (meta.legacyStages?.[value] ?? value) : value] ?? '',
      description: (state) => descriptions[state] ?? '',
      options: (kind) => Object.entries(kind === 'stage' ? index(meta.stages) : (labels[kind] ?? {}))
        .map(([value, label]) => ({ value, label })),
    }
  }, [meta])
}
