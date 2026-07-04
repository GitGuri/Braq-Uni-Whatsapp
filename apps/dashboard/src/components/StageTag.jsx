import { Tag } from 'antd'

const STAGE_CONFIG = {
  quotation_requested:   { label: 'Quotation Requested',   color: 'default' },
  quotation_submitted:   { label: 'Quotation Submitted',   color: 'blue' },
  po_received:           { label: 'PO Received',           color: 'cyan' },
  materials_procurement: { label: 'Materials Procurement', color: 'geekblue' },
  production_scheduled:  { label: 'Production Scheduled',  color: 'purple' },
  manufacturing:         { label: 'Manufacturing',         color: 'magenta' },
  branding_embroidery:   { label: 'Branding & Embroidery', color: 'volcano' },
  quality_control:       { label: 'Quality Control',       color: 'orange' },
  packing_dispatch:      { label: 'Packing & Dispatch',    color: 'gold' },
  completed:             { label: 'Completed',             color: 'green' },
}

export function stageLabel(stage) {
  return STAGE_CONFIG[stage]?.label ?? stage
}

export default function StageTag({ stage }) {
  const config = STAGE_CONFIG[stage] ?? { label: stage, color: 'default' }
  return <Tag color={config.color}>{config.label}</Tag>
}
