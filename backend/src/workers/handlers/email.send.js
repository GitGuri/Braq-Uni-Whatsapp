/**
 * 'email.send' — deliver one email through integrations/email.client.js.
 * payload: { to: string|string[], subject, text?, html? }
 */
import { PermanentJobError } from '../../core/queue.js';
import { sendEmail } from '../../integrations/email.client.js';

export default async function emailSend(payload) {
  const { to, subject, text, html } = payload || {};
  if (!to || (Array.isArray(to) && !to.length)) throw new PermanentJobError('email.send: payload.to is required');
  if (!subject) throw new PermanentJobError('email.send: payload.subject is required');
  const id = await sendEmail({ to, subject, text, html });
  return { id };
}
