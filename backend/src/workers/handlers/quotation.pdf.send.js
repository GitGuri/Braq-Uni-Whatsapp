/**
 * 'quotation.pdf.send' — render the quotation PDF, upload it to Meta and send it
 * to the client as a WhatsApp document; the message is recorded in the inbox.
 *
 * payload: { quotationId, conversationId? }
 *
 * Idempotent per job: a messages row with this job_id means the document already
 * went out (crash between send and complete) → skip. A failed upload/send throws
 * so the queue retries with backoff.
 *
 * 24-hour window: when the client last wrote more than 24 hours ago (e.g. staff
 * priced the quote the next day) the approved 'quote_ready' template is sent
 * with the PDF as its document header; with no template configured the message
 * is recorded as 'needs_template' and staff are emailed (whatsapp.send.js).
 */
import { query } from '../../core/db.js';
import { PermanentJobError } from '../../core/queue.js';
import { uploadMedia, sendDocument, sendTemplate, templateConfig, isReengagementError } from '../../integrations/whatsapp.client.js';
import { renderQuotationPdf, pdfToBuffer } from '../../modules/quotations/pdf.js';
import { VALIDITY_DAYS } from '../../modules/quotations/service.js';
import { TEMPLATE_FALLBACKS } from '../../modules/notifications/whatsapp.js';
import { notifyUndeliverable } from '../../modules/notifications/service.js';
import { fmtDate } from '../../modules/bot/templates.js';
import { recordOutbound, outsideCustomerWindow } from './whatsapp.send.js';

/** "19 Nov 2026" — the quote's valid_until, else approval date + validity days. */
function validUntilText(quotation) {
  if (quotation.valid_until) return fmtDate(quotation.valid_until);
  const from = new Date(quotation.approved_at || quotation.created_at || Date.now());
  return fmtDate(new Date(from.getTime() + VALIDITY_DAYS * 86400000));
}

export function quotationCaption(quotation) {
  const validUntil = validUntilText(quotation);
  return (
    `✅ Your quotation is ready! 📄\n\n` +
    `*Ref: ${quotation.reference}*\n` +
    `*Total: R ${Number(quotation.total).toFixed(2)} (incl. VAT)*\n\n` +
    `Reply *accept* to go ahead, *changes* to request edits, or *9* to talk to us.` +
    (validUntil ? ` Valid until ${validUntil}.` : '')
  );
}

export default async function quotationPdfSend(payload, { job }) {
  const { quotationId, conversationId = null } = payload || {};
  if (!quotationId) throw new PermanentJobError('quotation.pdf.send: payload.quotationId is required');

  const { rows: done } = await query('SELECT 1 FROM messages WHERE job_id = $1', [job.id]);
  if (done.length) return { skipped: 'already sent' };

  const { rows } = await query(
    `SELECT q.*, c.name AS client_name, c.organisation AS client_org,
            c.whatsapp_number AS client_wa, c.physical_address AS client_address
     FROM quotations q LEFT JOIN clients c ON c.id = q.client_id
     WHERE q.id = $1`,
    [quotationId]
  );
  const quotation = rows[0];
  if (!quotation) throw new PermanentJobError(`quotation.pdf.send: quotation ${quotationId} not found`);
  if (!quotation.client_wa) return { skipped: 'client has no WhatsApp number' };
  // The quote may have been revised back to draft (or declined) while this job
  // waited or retried: never send unreviewed prices with "Reply accept" (FIN-5).
  if (!['sent', 'accepted'].includes(quotation.status)) {
    return { skipped: `quotation is '${quotation.status}', not sent` };
  }

  const pdf = await pdfToBuffer(renderQuotationPdf(quotation, {
    name:             quotation.client_name,
    organisation:     quotation.client_org,
    whatsapp_number:  quotation.client_wa,
    physical_address: quotation.client_address,
  }));
  const filename = `${quotation.reference}.pdf`;
  const mediaId = await uploadMedia(pdf, filename);
  const caption = quotationCaption(quotation);
  const body = `[document: ${filename}] ${caption}`;
  const record = (metaMessageId, status = 'sent') => recordOutbound({
    to: quotation.client_wa,
    conversationId: conversationId || quotation.conversation_id,
    clientId: quotation.client_id,
    body,
    metaMessageId,
    jobId: job.id,
    status,
  });

  // Outside the 24-hour window only an approved template may be sent.
  const viaTemplate = async (reason) => {
    const fallback = TEMPLATE_FALLBACKS.quoteReady({
      client: { name: quotation.client_name }, reference: quotation.reference,
      total: quotation.total, validUntil: validUntilText(quotation),
    });
    const cfg = templateConfig(fallback.name);
    if (!cfg) {
      const stored = await record(null, 'needs_template');
      await notifyUndeliverable({ query }, {
        client: { name: quotation.client_name, whatsapp_number: quotation.client_wa },
        conversationId: conversationId || quotation.conversation_id,
        body, template: fallback.name, reason,
      });
      return { needsTemplate: true, stored };
    }
    const metaMessageId = await sendTemplate(quotation.client_wa, {
      name: cfg.name, language: cfg.language, params: fallback.params, document: { mediaId, filename },
    });
    return { metaMessageId, stored: await record(metaMessageId), template: cfg.name };
  };

  if (await outsideCustomerWindow({ clientId: quotation.client_id, to: quotation.client_wa })) {
    return viaTemplate('The client last messaged more than 24 hours ago, so WhatsApp only allows an approved template.');
  }
  let metaMessageId;
  try {
    metaMessageId = await sendDocument(quotation.client_wa, { mediaId, filename, caption });
  } catch (err) {
    if (!isReengagementError(err)) throw err;
    return viaTemplate('WhatsApp refused the message (error 131047: more than 24 hours since the client last replied).');
  }
  const stored = await record(metaMessageId);
  return { metaMessageId, stored };
}
