import { Steps } from 'antd'
import { STAGES, stageLabel } from './StageTag.jsx'

export default function OrderProgress({ stage }) {
  const currentIndex = STAGES.indexOf(stage)

  return (
    <Steps
      size="small"
      current={currentIndex}
      items={STAGES.map((s) => ({ title: stageLabel(s) }))}
      style={{ overflowX: 'auto' }}
    />
  )
}
