// Transactional email via Resend. Thin transport — the notifications module
// decides who gets what; durable sends go through the 'email.send' job.
import { Resend } from 'resend';
import { config } from '../core/config.js';
import { logger } from '../core/logger.js';

// Created on first use: the Resend constructor throws without an API key, and a
// missing key must not stop the API (or a CLI script) from starting.
let resend = null;
const client = () => (resend ??= new Resend(config.resend.apiKey));

/**
 * Send one email. Applies NOTIFICATION_OVERRIDE_EMAIL (all mail to one inbox
 * while the sending domain is unverified). Throws when Resend rejects it.
 * @returns {Promise<string|null>} Resend message id
 */
export async function sendEmail({ to, subject, text, html, idempotencyKey = null }) {
  let recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) throw new Error('sendEmail: no recipients');

  // Allow a single override email (for testing before braquni.com is verified on Resend)
  if (config.resend.overrideEmail) {
    logger.info('notification.service: NOTIFICATION_OVERRIDE_EMAIL set — routing all notifications to override address');
    recipients = [config.resend.overrideEmail];
  }

  const fromEmail = config.resend.fromEmail;

  // Warn when using Resend's shared test address — only delivers to the account owner
  if (fromEmail === 'onboarding@resend.dev') {
    logger.warn(
      'notification.service: FROM_EMAIL is still onboarding@resend.dev — ' +
      'Resend only delivers from this address to your Resend account owner email. ' +
      'Set NOTIFICATION_OVERRIDE_EMAIL=your@email.com to receive notifications now, ' +
      'or verify braquni.com at resend.com/domains and set FROM_EMAIL=notifications@braquni.com.'
    );
  }

  logger.info('Sending consultant email', { from: fromEmail, to: recipients, subject });
  const { data, error } = await client().emails.send({
    from:    `Braq Connect <${fromEmail}>`,
    to:      recipients,
    subject,
    ...(text != null ? { text } : {}),
    ...(html != null ? { html } : {}),
  }, idempotencyKey ? { idempotencyKey } : undefined); // a retried job never sends the same email twice (Q-6)
  if (error) {
    logger.error('Resend rejected email', {
      error,
      to: recipients,
      from: fromEmail,
      hint: fromEmail === 'onboarding@resend.dev'
        ? 'Using test sender — verify braquni.com at resend.com/domains'
        : 'Check RESEND_API_KEY and domain verification',
    });
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }
  logger.info('Consultant notification sent', { subject, recipients: recipients.length, messageId: data?.id });
  return data?.id ?? null;
}
