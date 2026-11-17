import Seam from './Seam.jsx'
import { JOURNEY_STEPS, journeyIndex, useStatus } from '../lib/status.js'

/**
 * The whole job lifecycle as a seam: Pricing → Quoted → Accepted → Deposit →
 * Proof → Production → Ready → Collected, sewn up to the current step.
 *   <JourneyBar state="AWAITING_DEPOSIT" flags={['ON_HOLD']} />
 */
export default function JourneyBar({ state, flags = [], size = 'lg' }) {
  const status = useStatus()
  const idx = journeyIndex(state)
  const held = flags.includes('ON_HOLD')
  const stopped = ['DECLINED', 'EXPIRED', 'CANCELLED'].includes(state)
  const complete = ['COMPLETED', 'AFTER_SALES'].includes(state)
  const stateLabel = status.label('job', state)
  const step = JOURNEY_STEPS[idx]
  const aria = `Job step ${idx + 1} of ${JOURNEY_STEPS.length}: ${step.label}${stateLabel && stateLabel !== step.label ? ` (${stateLabel})` : ''}${held ? ', on hold' : ''}`

  return (
    <div className="braq-journey">
      <Seam steps={JOURNEY_STEPS} index={idx} size={size} held={held} stopped={stopped} complete={complete} label={aria} className="journey" />
      {size === 'lg' && (
        <div className="braq-journey-compact" aria-hidden="true">
          Step {idx + 1} of {JOURNEY_STEPS.length} · <strong>{step.label}</strong>
        </div>
      )}
    </div>
  )
}
