import { Tag } from 'antd'

export const STAGES = [
  'quotation_requested',
  'quotation_submitted',
  'purchase_order_received',
  'design_approval_pending',
  'materials_procurement',
  'production_scheduled',
  'manufacturing',
  'branding_embroidery',
  'quality_control',
  'packing_dispatch',
  'completed',
]

const STAGE_CONFIG = {
  quotation_requested:   { label: 'Quotation Requested',   color: 'blue' },
  quotation_submitted:   { label: 'Quotation Submitted',   color: 'cyan' },
  purchase_order_received: { label: 'PO Received',         color: 'geekblue' },
  design_approval_pending: { label: 'Design Approval',     color: 'orange' },
  materials_procurement: { label: 'Materials Procurement', color: 'purple' },
  production_scheduled:  { label: 'Production Scheduled',  color: 'volcano' },
  manufacturing:         { label: 'Manufacturing',          color: 'magenta' },
  branding_embroidery:   { label: 'Branding/Embroidery',   color: 'gold' },
  quality_control:       { label: 'Quality Control',       color: 'lime' },
  packing_dispatch:      { label: 'Packing & Dispatch',    color: 'green' },
  completed:             { label: 'Completed',             color: 'success' },
}

export function stageLabel(stage) {
  return STAGE_CONFIG[stage]?.label ?? stage
}

export default function StageTag({ stage }) {
  const config = STAGE_CONFIG[stage] ?? { label: stage, color: 'default' }
  return <Tag color={config.color}>{config.label}</Tag>
}
