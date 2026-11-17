/**
 * Preloaded into the API process under test (node --import).
 * Blocks ALL outbound network except localhost and fakes WhatsApp (Meta Graph),
 * Gemini and Resend. Every faked call is appended as a JSON line to FAKE_LOG so
 * black-box tests can assert on what the server "sent" to the outside world.
 *
 * Gemini replies are read from FAKE_AI_FILE on every request (JSON: { text })
 * so a test can change what the AI "says" without restarting the server.
 *
 * FAKE_WA_FAIL names a file holding a number N: the next N WhatsApp sends
 * answer HTTP 500 (the file counts down) — for outbox retry / dead-letter tests.
 */
import fs from 'node:fs';
import nock from 'nock';

const LOG = process.env.FAKE_LOG;
const AI_FILE = process.env.FAKE_AI_FILE;
const WA_FAIL_FILE = process.env.FAKE_WA_FAIL;

/** True (and counts down) while the test asked for WhatsApp sends to fail. */
function takeWaFailure() {
  if (!WA_FAIL_FILE) return false;
  let n = 0;
  try { n = parseInt(fs.readFileSync(WA_FAIL_FILE, 'utf8'), 10) || 0; } catch { return false; }
  if (n <= 0) return false;
  fs.writeFileSync(WA_FAIL_FILE, String(n - 1));
  return true;
}

function record(service, method, path, body) {
  if (!LOG) return;
  fs.appendFileSync(LOG, JSON.stringify({ service, method, path, body, at: Date.now() }) + '\n');
}

function parse(body) {
  if (typeof body !== 'string') return body;
  try { return JSON.parse(body); } catch { return body; }
}

nock.disableNetConnect();
nock.enableNetConnect(/(localhost|127\.0\.0\.1)/);

nock('https://graph.facebook.com')
  .persist()
  .post(/\/messages$/)
  .reply(function (uri, body) {
    if (takeWaFailure()) {
      record('whatsapp-failed', 'POST', uri, parse(body));
      return [500, { error: { message: 'fake outage', code: 1 } }];
    }
    record('whatsapp', 'POST', uri, parse(body));
    return [200, { messaging_product: 'whatsapp', messages: [{ id: `wamid.FAKE_${Date.now()}_${Math.random().toString(36).slice(2, 8)}` }] }];
  })
  .post(/\/media$/)
  .reply(200, function (uri) {
    record('whatsapp-media', 'POST', uri, null);
    return { id: 'FAKE_MEDIA_ID' };
  });

nock('https://generativelanguage.googleapis.com')
  .persist()
  .post(/.*/)
  .reply(200, function (uri, body) {
    record('gemini', 'POST', uri, parse(body));
    let text = '{}';
    try { text = JSON.parse(fs.readFileSync(AI_FILE, 'utf8')).text ?? '{}'; } catch { /* default */ }
    return {
      candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    };
  });

nock('https://api.resend.com')
  .persist()
  .post(/.*/)
  .reply(200, function (uri, body) {
    record('resend', 'POST', uri, parse(body));
    return { id: `FAKE_EMAIL_${Date.now()}` };
  });
