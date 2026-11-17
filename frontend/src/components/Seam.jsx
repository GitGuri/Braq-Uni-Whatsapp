import { useEffect, useRef, useState } from 'react'
import { STAGES, stageIndex } from '../lib/stages.js'

/**
 * Progress drawn as a seam: dashed thread between knots, sewn in red up to the
 * current step. When the step changes (or the large seam first appears) the red
 * stitching runs forward to the new knot.
 *
 *   <Seam stage="in_production" />                 order stages, large, labelled
 *   <Seam stage="ready" size="sm" />               compact, for table rows
 *   <Seam stage="in_production" held />            amber thread while on hold
 *   <Seam steps={[{key,label,short}]} index={3} /> any sequence (the job journey)
 *   <Seam … stopped />                             grey thread (declined / expired)
 */
export default function Seam({
  stage, steps = STAGES, index, size = 'lg', held = false, stopped = false,
  animate = size === 'lg', label: ariaLabel, className = '', complete,
}) {
  const idx = Math.max(0, index ?? stageIndex(stage))
  const last = steps.length - 1
  const target = (idx / last) * 100
  // The last step counts as reached (all knots filled) unless told otherwise.
  const done = complete ?? idx === last

  // Large seams sew in from the start on first paint; compact ones render settled.
  const [sewn, setSewn] = useState(animate ? 0 : target)
  const prevIdx = useRef(animate ? -1 : idx)
  const [arrived, setArrived] = useState(null)

  useEffect(() => {
    if (!animate) { setSewn(target); return undefined }
    const raf = requestAnimationFrame(() => setSewn(target))
    if (prevIdx.current !== idx) setArrived(idx)
    prevIdx.current = idx
    return () => cancelAnimationFrame(raf)
  }, [target, idx, animate])

  const current = steps[idx]
  const label = ariaLabel ?? `Stage ${idx + 1} of ${steps.length}: ${current?.label ?? stage}${held ? ' (on hold)' : ''}`

  return (
    <div
      className={`braq-seam ${size}${held ? ' held' : ''}${stopped ? ' stopped' : ''} ${className}`.trim()}
      role="img"
      aria-label={label}
      title={size === 'sm' ? label : undefined}
    >
      <div className="braq-seam-track">
        <div className="braq-seam-thread" />
        <div className="braq-seam-sewn" style={{ width: `${sewn}%` }} />
        {steps.map((s, i) => (
          <span
            key={s.key}
            className={`braq-seam-node${i < idx || (done && i === idx) ? ' done' : ''}${i === idx && !done ? ' current' : ''}${animate && i === arrived ? ' arrived' : ''}`}
            style={{ left: `${(i / last) * 100}%` }}
          />
        ))}
      </div>
      {size === 'lg' && (
        <div className="braq-seam-labels" aria-hidden="true">
          {steps.map((s, i) => (
            <span
              key={s.key}
              className={`braq-seam-label${i < idx ? ' done' : ''}${i === idx ? ' current' : ''}`}
              style={{ left: `${(i / last) * 100}%` }}
            >
              <span className="long">{s.label}</span>
              <span className="short">{s.short}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
