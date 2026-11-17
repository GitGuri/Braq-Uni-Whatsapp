// The order pipeline. Static fallback for GET /api/meta `stages` (backend
// src/modules/lifecycle/machines.js ORDER_STAGES / STAGE_META is the source).
export const STAGES = [
  { key: 'deposit_pending', label: 'Awaiting deposit', short: 'Deposit', description: 'Waiting for the client to pay the deposit' },
  { key: 'in_production',   label: 'In production',    short: 'Production', description: 'Being made, branded and checked' },
  { key: 'ready',           label: 'Ready',            short: 'Ready', description: 'Packed — ready for collection or dispatch' },
  { key: 'completed',       label: 'Completed',        short: 'Done', description: 'Collected or delivered' },
]

// Older orders may still carry stage names from the previous 10-stage pipeline.
export const LEGACY_STAGES = {
  quotation_requested: 'deposit_pending', quotation_submitted: 'deposit_pending',
  po_received: 'deposit_pending', purchase_order_received: 'deposit_pending',
  design_approval_pending: 'deposit_pending',
  materials_procurement: 'in_production', production_scheduled: 'in_production',
  manufacturing: 'in_production', branding_embroidery: 'in_production', quality_control: 'in_production',
  packing_dispatch: 'ready',
}

export const normaliseStage = (stage) => LEGACY_STAGES[stage] ?? stage

export const stageIndex = (stage) => STAGES.findIndex((s) => s.key === normaliseStage(stage))

export function stageLabel(stage) {
  const s = STAGES[stageIndex(stage)]
  if (s) return s.label
  return String(stage ?? '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

export const STAGE_OPTIONS = STAGES.map((s) => ({ value: s.key, label: s.label }))
