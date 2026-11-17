import { Form, Input, InputNumber, Select, Button, Popconfirm, Checkbox } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { listStaff } from '../api/staff.js'
import { qk } from '../lib/queryKeys.js'
import { useStatus } from '../lib/status.js'
import { sentence } from '../lib/format.js'

const OPTION_LABELS = {
  deliveryType: { collection: 'Collection — the client collects from the store', delivery: 'Delivery — sent by courier' },
  type: { deposit: 'Deposit', balance: 'Balance', full: 'Full payment' },
}
const LONG_TEXT = ['notes', 'description', 'resolutionNote']
// Confirm before steps that are hard to take back. Not red: declining is not destructive.
const CONFIRM = {
  mark_declined: { title: 'Mark this quote declined?', description: 'You can revise and resend it later.', okText: 'Mark declined' },
}

/** Default form values from an action's inputs. */
export function actionDefaults(action) {
  const out = {}
  for (const i of action?.inputs ?? []) if (i.default !== undefined && i.default !== null) out[i.name] = i.default
  return out
}

function StaffSelect(props) {
  const { data } = useQuery({ queryKey: qk.staff, queryFn: listStaff })
  const staff = data?.staff ?? []
  return <Select allowClear placeholder="Choose a staff member" options={staff.map((s) => ({ value: s.id, label: s.name }))} {...props} />
}

/** Label: required fields and money as given; anything else optional gets "(optional)" once. */
function fieldLabel(input) {
  const label = input.label ?? input.name
  if (input.required || input.type === 'money' || input.type === 'checkbox') return label
  return /\(optional\)|\(if any\)/i.test(label) ? label : `${label} (optional)`
}

function Field({ input, formName }) {
  const status = useStatus()
  const id = `${formName}_${input.name}`
  // Rules need an explicit type: a rule with extra keys and no type is validated as a string.
  const message = `Enter ${String(input.label ?? input.name).replace(/\s*\(R\)$/, '').toLowerCase()}`
  const rules = !input.required ? []
    : input.type === 'money' ? [{ required: true, type: 'number', message }]
      : ['text', 'url'].includes(input.type) ? [{ required: true, whitespace: true, message }]
        : [{ required: true, message }]
  if (input.type === 'url') rules.push({ type: 'url', message: 'Enter a full link, starting with https://' })
  if (input.type === 'money') rules.push({ type: 'number', min: input.required ? 0.01 : 0, message: input.required ? 'Enter an amount above zero' : 'Enter zero or more' })

  if (input.type === 'checkbox') {
    return (
      <Form.Item name={input.name} valuePropName="checked" className="braq-field-wide braq-field-check">
        <Checkbox id={id}>{input.label}</Checkbox>
      </Form.Item>
    )
  }

  let control
  switch (input.type) {
    case 'money':
      control = <InputNumber id={id} min={0} step={0.01} precision={2} prefix="R" style={{ width: '100%' }} />
      break
    case 'date':
      control = <Input id={id} type="date" />
      break
    case 'url':
      control = <Input id={id} type="url" placeholder="https://drive.google.com/…" inputMode="url" />
      break
    case 'select': {
      const labels = input.name === 'category'
        ? Object.fromEntries((input.options ?? []).map((o) => [o, status.label('category', o)]))
        : OPTION_LABELS[input.name] ?? {}
      control = <Select id={id} options={(input.options ?? []).map((o) => ({ value: o, label: labels[o] ?? sentence(o) }))} placeholder="Choose one" />
      break
    }
    case 'staff':
      control = <StaffSelect id={id} />
      break
    default:
      control = LONG_TEXT.includes(input.name)
        ? <Input.TextArea id={id} rows={2} autoSize={{ minRows: 2, maxRows: 5 }} />
        : <Input id={id} />
  }

  const item = (
    <Form.Item
      name={input.name}
      label={fieldLabel(input)}
      rules={rules}
      className={LONG_TEXT.includes(input.name) ? 'braq-field-wide' : undefined}
    >
      {control}
    </Form.Item>
  )

  // Tracking only matters for deliveries.
  if (input.name === 'trackingNumber') {
    return (
      <Form.Item noStyle shouldUpdate={(a, b) => a.deliveryType !== b.deliveryType}>
        {({ getFieldValue }) => (getFieldValue('deliveryType') === 'delivery' ? item : null)}
      </Form.Item>
    )
  }
  // `showIf`: only while another (checkbox) input is ticked, e.g. the due date under "Start production now".
  if (input.showIf) {
    return (
      <Form.Item noStyle shouldUpdate={(a, b) => a[input.showIf] !== b[input.showIf]}>
        {({ getFieldValue }) => (getFieldValue(input.showIf) ? item : null)}
      </Form.Item>
    )
  }
  return item
}

/**
 * The inputs of one next action plus its submit button.
 *   <ActionForm action={a} onSubmit={(values) => …} pending primary extra={<…/>} />
 * `renderSpecial(input)` renders non-form inputs (e.g. the quote's line items);
 * `extra` renders next to the submit button.
 */
export default function ActionForm({
  action, onSubmit, pending = false, primary = false, disabled = false, disabledReason,
  renderSpecial, submitLabel, onCancel, form: externalForm, hideSubmit = false, extra = null,
}) {
  const [ownForm] = Form.useForm()
  const form = externalForm ?? ownForm
  const formName = `act-${action.key}${action.ticketId ? `-${action.ticketId.slice(0, 8)}` : ''}`
  const inputs = (action.inputs ?? []).filter((i) => i.type !== 'hidden')
  const special = inputs.filter((i) => i.type === 'lineItems')
  const fields = inputs.filter((i) => i.type !== 'lineItems')
  const confirm = CONFIRM[action.key]

  const submit = async () => {
    let values
    try { values = await form.validateFields() } catch { return }
    onSubmit({ ...actionDefaults(action), ...values })
  }

  const button = (
    <Button
      type={primary ? 'primary' : 'default'}
      loading={pending}
      disabled={disabled}
      htmlType={confirm ? 'button' : 'submit'}
    >
      {submitLabel ?? action.label}
    </Button>
  )

  return (
    <Form
      form={form}
      name={formName}
      layout="vertical"
      initialValues={actionDefaults(action)}
      onFinish={confirm ? undefined : (values) => onSubmit({ ...actionDefaults(action), ...values })}
      className="braq-action-form"
      requiredMark={false}
    >
      {special.map((i) => <div key={i.name} className="braq-field-wide">{renderSpecial?.(i)}</div>)}
      {fields.length > 0 && (
        <div className="braq-action-fields">
          {fields.map((i) => <Field key={i.name} input={i} formName={formName} />)}
        </div>
      )}
      {!hideSubmit && (
        <div className="braq-action-buttons">
          {confirm ? (
            <Popconfirm title={confirm.title} description={confirm.description} okText={confirm.okText} onConfirm={submit} disabled={disabled}>
              {button}
            </Popconfirm>
          ) : button}
          {extra}
          {onCancel && <Button type="text" onClick={onCancel}>Cancel</Button>}
          {disabled && disabledReason && <span className="braq-action-hint">{disabledReason}</span>}
        </div>
      )}
    </Form>
  )
}
