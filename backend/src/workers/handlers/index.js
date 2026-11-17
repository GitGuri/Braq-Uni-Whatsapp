// Job type → handler(payload, { job }).
import whatsappSend from './whatsapp.send.js';
import emailSend from './email.send.js';
import quotationPdfSend from './quotation.pdf.send.js';
import reminderScan from './reminder.scan.js';
import quotationExpire from './quotation.expire.js';
import inboundProcess from './inbound.process.js';
import messageStatus from './message.status.js';
import broadcastFanout from './broadcast.fanout.js';

export const handlers = {
  'whatsapp.send':      whatsappSend,
  'email.send':         emailSend,
  'quotation.pdf.send': quotationPdfSend,
  'reminder.scan':      reminderScan,
  'quotation.expire':   quotationExpire,
  'inbound.process':    inboundProcess,
  'message.status':     messageStatus,
  'broadcast.fanout':   broadcastFanout,
};
