import { useEffect, useRef, useState } from 'react'
import { App, Alert, Button } from 'antd'
import { LockOutlined, CheckCircleOutlined } from '@ant-design/icons'
import ActionForm from './ActionForm.jsx'
import OverrideDialog, { SKIP_CHECK_LABEL } from './OverrideDialog.jsx'
import { useStatus } from '../lib/status.js'
import { useCan } from '../lib/useCan.js'

const keyOf = (a) => a.key + (a.ticketId ? `:${a.ticketId}` : '')

/**
 * "Next step" — renders lifecycle.nextActions as the backend sends them:
 *   - the primary enabled action, with its inputs inline;
 *   - blocked actions with every check that blocks them (and, for admins /
 *     managers on overridable checks, "Skip the check (manager)…" asking for a reason);
 *   - other enabled actions as secondary buttons that open their inputs.
 * No business rules here: what is possible, and why not, comes from the API.
 *
 *   <NextStepCard lifecycle={job.lifecycle} context={…} run={(action, values, ctx) => …} pendingKey={…} />
 *   run() resolves { ok, message } or { ok: false, error: { message, code, overridable } }.
 */
export default function NextStepCard({ lifecycle, context, run, pendingKey, renderSpecial, specialBlocker, specialPayload }) {
  const { message } = App.useApp()
  const status = useStatus()
  const can = useCan()
  const headingRef = useRef(null)
  const [openKey, setOpenKey] = useState(null)       // secondary action whose inputs are open
  const [errors, setErrors] = useState({})          // action key → actionError
  const [override, setOverride] = useState(null)    // { action, reason, blockers } being overridden
  const [overrideError, setOverrideError] = useState(null)
  const [announce, setAnnounce] = useState('')

  const state = lifecycle?.state
  const actions = lifecycle?.nextActions ?? []
  const complete = state === 'COMPLETED'
  let primary = actions.find((a) => a.primary && a.enabled) ?? null
  if (complete && primary?.key === 'open_ticket') primary = null
  const blocked = actions.filter((a) => !a.enabled)
  const secondary = actions.filter((a) => a.enabled && a !== primary)

  // A different state means a different set of actions: close stale forms and errors.
  useEffect(() => { setOpenKey(null); setErrors({}) }, [state])

  const submit = async (action, values, ctx = {}) => {
    setErrors((e) => ({ ...e, [keyOf(action)]: null }))
    const res = await run(action, values, { ...ctx, ...(action.inputs?.some((i) => i.type === 'lineItems') ? { lineItems: specialPayload } : {}) })
    if (res.ok) {
      setOpenKey(null)
      setOverride(null)
      setOverrideError(null)
      if (res.message?.type === 'warning') message.warning(res.message.text)
      else message.success(res.message?.text ?? 'Done')
      setAnnounce(`${res.message?.text ?? 'Done'}.`)
      // Keep keyboard users in place: the heading names the new next step.
      requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }))
      return true
    }
    if (ctx.override) setOverrideError(res.error)
    else setErrors((e) => ({ ...e, [keyOf(action)]: res.error }))
    return false
  }

  const startOverride = (action, reason, blockers) => { setOverrideError(null); setOverride({ action, reason, blockers }) }

  const errorFor = (action) => {
    const err = errors[keyOf(action)]
    if (!err) return null
    const mayOverride = err.overridable && can('order.override')
    return (
      <Alert
        type={err.status === 409 ? 'warning' : 'error'}
        showIcon
        className="braq-next-error"
        message={err.status === 409 ? `${action.label} is blocked` : `${action.label} did not go through`}
        description={(
          <>
            <div>{err.message}</div>
            {err.blockers?.length > 1 && <ul className="braq-blocker-list">{err.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>}
            {err.reasons?.length > 0 && <ul className="braq-blocker-list">{err.reasons.map((r) => <li key={r}>{r}</li>)}</ul>}
            {err.overridable && !mayOverride && <div style={{ marginTop: 4 }}>An admin or manager can skip this check.</div>}
          </>
        )}
        action={mayOverride ? <Button size="small" onClick={() => startOverride(action, err.message, err.blockers)}>{SKIP_CHECK_LABEL}</Button> : undefined}
      />
    )
  }

  const heading = primary
    ? primary.label
    : complete ? 'Job complete'
      : blocked.length ? 'Waiting on a blocked step'
        : 'Nothing to do right now'

  const why = context?.[state] ?? status.description(state)

  return (
    <section className="braq-panel braq-next" aria-labelledby="next-step-title">
      <div className="braq-next-head">
        <span className="braq-next-kicker">Next step</span>
        <h2 id="next-step-title" className="braq-next-title" ref={headingRef} tabIndex={-1}>
          {complete && <CheckCircleOutlined aria-hidden="true" style={{ color: 'var(--good)', marginRight: 8 }} />}
          {heading}
        </h2>
        {why && <p className="braq-next-why">{why}</p>}
      </div>

      <div aria-live="polite" className="braq-visually-hidden">{announce}</div>

      {primary && (
        <div className="braq-next-primary">
          <ActionForm
            key={`${state}-${keyOf(primary)}`}
            action={primary}
            primary
            pending={pendingKey === keyOf(primary)}
            onSubmit={(values) => submit(primary, values)}
            renderSpecial={renderSpecial}
            disabled={primary.inputs?.some((i) => i.type === 'lineItems') && !!specialBlocker}
            disabledReason={specialBlocker}
          />
          {errorFor(primary)}
        </div>
      )}

      {blocked.length > 0 && (
        <ul className="braq-next-blocked" aria-label="Blocked steps">
          {blocked.map((a) => (
            <li key={keyOf(a)} className="braq-blocked">
              <LockOutlined aria-hidden="true" className="braq-blocked-icon" />
              <div style={{ flex: 1, minWidth: 0 }}>
                {a.blockers?.length > 1 ? (
                  <>
                    <div><strong>{a.label}</strong> — waiting on {a.blockers.length} things:</div>
                    <ul className="braq-blocker-list">{a.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>
                  </>
                ) : (
                  <div><strong>{a.label}</strong> — {a.reason ?? 'Not available yet'}</div>
                )}
                {a.requiresOverride && !a.overrideAllowed && (
                  <div className="braq-blocked-note">An admin or manager can skip this check.</div>
                )}
              </div>
              {a.requiresOverride && a.overrideAllowed && (
                <Button size="small" onClick={() => startOverride(a, a.reason, a.blockers)}>{SKIP_CHECK_LABEL}</Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {secondary.length > 0 && (
        <div className="braq-next-more">
          <div className="braq-next-more-label">{primary ? 'Other actions' : 'Actions'}</div>
          <div className="braq-next-more-buttons">
            {secondary.map((a) => {
              const k = keyOf(a)
              const hasInputs = (a.inputs ?? []).some((i) => i.type !== 'hidden')
              const open = openKey === k
              if (!hasInputs) {
                return (
                  <ActionForm
                    key={k}
                    action={a}
                    pending={pendingKey === k}
                    onSubmit={(values) => submit(a, values)}
                  />
                )
              }
              return (
                <Button key={k} aria-expanded={open} aria-controls={`more-${k}`} onClick={() => setOpenKey(open ? null : k)} type={open ? 'primary' : 'default'} ghost={open}>
                  {a.label}
                </Button>
              )
            })}
          </div>
          {secondary.filter((a) => openKey === keyOf(a)).map((a) => (
            <div key={keyOf(a)} id={`more-${keyOf(a)}`} className="braq-next-more-form">
              <ActionForm
                action={a}
                primary
                pending={pendingKey === keyOf(a)}
                onSubmit={(values) => submit(a, values)}
                onCancel={() => setOpenKey(null)}
              />
            </div>
          ))}
          {secondary.map((a) => <div key={`err-${keyOf(a)}`}>{errorFor(a)}</div>)}
        </div>
      )}

      {override && <OverrideDialog
        open
        action={override?.action}
        blockedBy={override?.reason}
        blockers={override?.blockers}
        pending={!!override && pendingKey === keyOf(override.action)}
        error={overrideError}
        onCancel={() => { setOverride(null); setOverrideError(null) }}
        onSubmit={(values, reason) => submit(override.action, values, { override: { reason } })}
      />}
    </section>
  )
}
