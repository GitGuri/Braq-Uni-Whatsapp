import { useState } from 'react'
import { Modal, Form, Input, Alert } from 'antd'
import ActionForm, { actionDefaults } from './ActionForm.jsx'
import { lowerFirst } from '../lib/format.js'

export const OVERRIDE_REASON_MIN = 5

/** "Skip the check (manager)…" — the button that opens this dialog. */
export const SKIP_CHECK_LABEL = 'Skip the check (manager)…'

/**
 * Push a blocked step through (admin / manager). Lists every check that blocks
 * the step, collects the step's own inputs and a reason (≥ 5 characters),
 * which is recorded in the job history.
 *
 * Mount it only while open (fresh forms each time):
 *   {override && <OverrideDialog open action={a} blockers={[{ code, message }]} blockedBy="…"
 *                   onSubmit={(values, reason) => …} onCancel={…} pending error={…} />}
 */
export default function OverrideDialog({ open, action, blockedBy, blockers, onSubmit, onCancel, pending = false, error = null }) {
  const [inputsForm] = Form.useForm()
  const [reasonForm] = Form.useForm()
  const [touched, setTouched] = useState(false)

  if (!action) return null

  const hasInputs = (action.inputs ?? []).some((i) => i.type !== 'hidden' && i.type !== 'lineItems')
  const list = (blockers?.length ? blockers.map((b) => b.message) : [blockedBy]).filter(Boolean)

  const confirm = async () => {
    setTouched(true)
    let values = {}
    let reason
    if (hasInputs) { try { values = await inputsForm.validateFields() } catch { return } }
    try { ({ reason } = await reasonForm.validateFields()) } catch { return }
    onSubmit({ ...actionDefaults(action), ...values }, reason.trim())
  }

  return (
    <Modal
      open={open}
      title={`Skip the check: ${lowerFirst(action.label)}`}
      onCancel={onCancel}
      onOk={confirm}
      okText={`Skip the check and ${lowerFirst(action.label)}`}
      okButtonProps={{ loading: pending }}
      cancelText="Cancel"
      width={520}
    >
      <Alert
        type="warning"
        showIcon
        style={{ margin: '12px 0 16px' }}
        message={list.length > 1 ? `This step is blocked by ${list.length} checks` : 'This step is normally blocked'}
        description={list.length > 1
          ? <ul className="braq-blocker-list">{list.map((m) => <li key={m}>{m}</li>)}</ul>
          : list[0]}
      />
      {hasInputs && (
        <ActionForm action={action} form={inputsForm} hideSubmit onSubmit={() => {}} />
      )}
      <Form form={reasonForm} layout="vertical" name="override" requiredMark={false} validateTrigger={touched ? 'onChange' : 'onSubmit'}>
        <Form.Item
          name="reason"
          label="Why are you skipping the check?"
          extra="Recorded in the job history with your name."
          rules={[
            { required: true, whitespace: true, message: 'Give a reason' },
            {
              validator: (_, v) => (!v || v.trim().length >= OVERRIDE_REASON_MIN
                ? Promise.resolve()
                : Promise.reject(new Error(`Write at least ${OVERRIDE_REASON_MIN} characters`))),
            },
          ]}
        >
          <Input.TextArea rows={3} placeholder="e.g. School account on 30-day terms — deposit waived by the manager" />
        </Form.Item>
      </Form>
      {error && (
        <Alert type="error" showIcon message="That did not go through" description={error.message} />
      )}
    </Modal>
  )
}
