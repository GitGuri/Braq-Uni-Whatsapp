import { config } from '../config/index.js';
import { handleInbound } from '../services/bot.service.js';
import { logger } from '../utils/logger.js';

// ── GET /webhook — Meta verification handshake ────────────────────────────────
export function verify(req, res) {
  const mode      = req.query['hub.mode'];
  const token     = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.meta.webhookVerify) {
    logger.info('Webhook verified by Meta');
    return res.status(200).send(challenge);
  }

  logger.warn('Webhook verification failed', { mode, token });
  return res.sendStatus(403);
}

// ── POST /webhook — incoming messages and status updates ──────────────────────
export async function receive(req, res) {
  // Always respond 200 immediately — Meta will retry if we don't
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;

        // ── Inbound messages ────────────────────────────────────────────────
        for (const msg of value.messages || []) {
          if (msg.type !== 'text') {
            logger.info('Non-text message received, ignoring', { type: msg.type });
            continue;
          }

          const phoneNumber   = msg.from;
          const metaMessageId = msg.id;
          const messageBody   = msg.text?.body?.trim() || '';

          if (!messageBody) continue;

          // Process async — don't await so we don't block the 200 response
          handleInbound({ phoneNumber, metaMessageId, body: messageBody })
            .catch(err => logger.error('Error handling inbound message', {
              error: err.message, phoneNumber,
            }));
        }

        // ── Status updates (delivered, read, failed) ────────────────────────
        for (const status of value.statuses || []) {
          logger.debug('Message status update', {
            messageId: status.id,
            status:    status.status,
            recipient: status.recipient_id,
          });
          // TODO: update messages table status column
        }
      }
    }
  } catch (err) {
    logger.error('Webhook processing error', { error: err.message });
  }
}
