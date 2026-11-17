import './_setup.js';
import { describe, test, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { src, nock } from './_setup.js';

const HOST = 'https://graph.facebook.com';
const PATH = '/v20.0/111222333';
let wa;
before(async () => { wa = await import(src('integrations/whatsapp.client.js')); });
afterEach(() => { assert.deepEqual(nock.pendingMocks(), []); nock.cleanAll(); });

const graph = () => nock(HOST, { reqheaders: { authorization: 'Bearer fake' } });
const capture = (status, body) => {
  const seen = [];
  graph().post(`${PATH}/messages`, (b) => { seen.push(b); return true; }).reply(status, body);
  return seen;
};
const metaError = { error: { message: '(#131030) Recipient not in allowed list', type: 'OAuthException', code: 131030 } };

describe('sendTextMessage', () => {
  test('payload + returns message id', async () => {
    const seen = capture(200, { messages: [{ id: 'wamid.ABC' }] });
    assert.equal(await wa.sendTextMessage('27820000000', 'Hello *there* 👋'), 'wamid.ABC');
    assert.deepEqual(seen[0], {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '27820000000',
      type: 'text', text: { body: 'Hello *there* 👋', preview_url: false },
    });
  });

  test('missing messages array → null id', async () => {
    capture(200, {});
    assert.equal(await wa.sendTextMessage('1', 'x'), null);
  });

  test('Graph API error is wrapped with the JSON error detail', async () => {
    capture(400, metaError);
    await assert.rejects(wa.sendTextMessage('1', 'x'), (e) => {
      assert.equal(e.message, `WhatsApp send failed: ${JSON.stringify(metaError.error)}`);
      return true;
    });
  });

  test('network error (no response) is wrapped with err.message', async () => {
    graph().post(`${PATH}/messages`).replyWithError('ECONNRESET');
    await assert.rejects(wa.sendTextMessage('1', 'x'), /^Error: WhatsApp send failed: "ECONNRESET"$|WhatsApp send failed: "ECONNRESET"/);
  });
});

describe('sendImage', () => {
  test('by mediaId with caption', async () => {
    const seen = capture(200, { messages: [{ id: 'i1' }] });
    assert.equal(await wa.sendImage('27', { mediaId: 'm1', caption: 'Look' }), 'i1');
    assert.deepEqual(seen[0].image, { id: 'm1', caption: 'Look' });
    assert.equal(seen[0].type, 'image');
  });

  test('by url without caption (no caption key)', async () => {
    const seen = capture(200, {});
    assert.equal(await wa.sendImage('27', { url: 'https://x/y.png' }), null);
    assert.deepEqual(seen[0].image, { link: 'https://x/y.png' });
  });

  test('error wrapped', async () => {
    capture(400, metaError);
    await assert.rejects(wa.sendImage('27', { url: 'u' }), /^Error: WhatsApp image send failed: \{"message"|WhatsApp image send failed: \{"message"/);
  });
});

describe('sendDocument', () => {
  test('by mediaId', async () => {
    const seen = capture(200, { messages: [{ id: 'd1' }] });
    assert.equal(await wa.sendDocument('27', { mediaId: 'm', filename: 'Q.pdf', caption: 'Your quote' }), 'd1');
    assert.deepEqual(seen[0].document, { id: 'm', filename: 'Q.pdf', caption: 'Your quote' });
  });

  test('by link', async () => {
    const seen = capture(200, {});
    await wa.sendDocument('27', { url: 'https://x/q.pdf', filename: 'q.pdf' });
    assert.deepEqual(seen[0].document, { link: 'https://x/q.pdf', filename: 'q.pdf' });
  });

  test('error wrapped', async () => {
    capture(401, { error: { message: 'bad token' } });
    await assert.rejects(wa.sendDocument('27', { url: 'u' }), /WhatsApp document send failed: \{"message":"bad token"\}/);
  });
});

describe('uploadMedia', () => {
  test('multipart upload to /media with bearer token; returns id', async () => {
    let body = '';
    let ctype = '';
    graph().post(`${PATH}/media`, (b) => { body = typeof b === 'string' ? b : Buffer.from(b, 'hex').toString(); return true; })
      .reply(function () { ctype = this.req.headers['content-type']; return [200, { id: 'media-77' }]; });
    const id = await wa.uploadMedia(Buffer.from('%PDF-1.3 test'), 'BRQ-Q-1.pdf');
    assert.equal(id, 'media-77');
    assert.match(ctype, /multipart\/form-data; boundary=/);
    assert.match(body, /name="messaging_product"\r\n\r\nwhatsapp/);
    assert.match(body, /name="file"; filename="BRQ-Q-1\.pdf"/);
    assert.match(body, /Content-Type: application\/pdf/);
    assert.match(body, /%PDF-1\.3 test/);
  });

  test('custom mime type', async () => {
    let body = '';
    graph().post(`${PATH}/media`, (b) => { body = String(b); return true; }).reply(200, { id: 'm' });
    await wa.uploadMedia(Buffer.from('img'), 'a.png', 'image/png');
    assert.match(body, /Content-Type: image\/png/);
  });

  test('missing id → undefined; HTTP error propagates (not wrapped)', async () => {
    graph().post(`${PATH}/media`).reply(200, {});
    assert.equal(await wa.uploadMedia(Buffer.from('x'), 'x.pdf'), undefined);
    graph().post(`${PATH}/media`).reply(500, metaError);
    await assert.rejects(wa.uploadMedia(Buffer.from('x'), 'x.pdf'), /status code 500/);
  });
});

describe('templates (24-hour window) and Meta error codes', () => {
  test('errors carry the Meta error code; 131047 is the re-engagement error', async () => {
    capture(400, { error: { message: 'Re-engagement message', code: 131047 } });
    await assert.rejects(wa.sendTextMessage('1', 'x'), (e) => {
      assert.equal(e.metaCode, 131047);
      assert.equal(e.httpStatus, 400);
      assert.equal(wa.isReengagementError(e), true);
      return true;
    });
    capture(400, metaError);
    await assert.rejects(wa.sendTextMessage('1', 'x'), (e) => !wa.isReengagementError(e) && e.metaCode === 131030);
  });

  test('MSG-3 isPermanentSendError: 400/404 that are not rate limits / outages / re-engagement', () => {
    const e = (httpStatus, metaCode) => ({ httpStatus, metaCode });
    assert.equal(wa.isPermanentSendError(e(400, 100)), true, 'invalid parameter');
    assert.equal(wa.isPermanentSendError(e(400, 131026)), true, 'undeliverable');
    assert.equal(wa.isPermanentSendError(e(404, null)), true);
    assert.equal(wa.isPermanentSendError(e(400, 131047)), false, 're-engagement has its own template path');
    assert.equal(wa.isPermanentSendError(e(400, 130429)), false, 'throughput limit → retry');
    assert.equal(wa.isPermanentSendError(e(400, 131056)), false, 'pair rate limit → retry');
    assert.equal(wa.isPermanentSendError(e(401, 190)), false, 'expired token → retry (ops can fix it)');
    assert.equal(wa.isPermanentSendError(e(429, 4)), false);
    assert.equal(wa.isPermanentSendError(e(500, 1)), false);
    assert.equal(wa.isPermanentSendError(e(null, null)), false, 'network error → retry');
  });

  test('MSG-3 text and captions are clipped to WhatsApp limits (whole characters, "…" appended)', async () => {
    assert.equal(wa.clipText('abc', 5), 'abc');
    assert.equal(wa.clipText('abcdef', 5), 'abcd…');
    assert.equal(Array.from(wa.clipText('👋'.repeat(10), 5)).length, 5, 'never splits an emoji');
    const seen = capture(200, { messages: [{ id: 'wamid.LONG' }] });
    await wa.sendTextMessage('1', 'x'.repeat(5000));
    assert.equal(seen[0].text.body.length, wa.MAX_TEXT_LENGTH);
    const seenDoc = capture(200, { messages: [{ id: 'wamid.DOC' }] });
    await wa.sendDocument('1', { mediaId: 'M', filename: 'q.pdf', caption: 'c'.repeat(2000) });
    assert.equal(seenDoc[0].document.caption.length, wa.MAX_CAPTION_LENGTH);
  });

  test('templateConfig reads WHATSAPP_TEMPLATES (name or { name, language }); bad JSON / unknown → null', () => {
    const env = JSON.stringify({ order_stage: 'braq_order_stage', quote_ready: { name: 'braq_quote_ready', language: 'en_US' }, bad: {} });
    assert.deepEqual(wa.templateConfig('order_stage', env), { name: 'braq_order_stage', language: 'en' });
    assert.deepEqual(wa.templateConfig('quote_ready', env), { name: 'braq_quote_ready', language: 'en_US' });
    assert.equal(wa.templateConfig('bad', env), null);
    assert.equal(wa.templateConfig('missing', env), null);
    assert.equal(wa.templateConfig('order_stage', '{oops'), null);
    assert.equal(wa.templateConfig('order_stage', ''), null);
  });

  test('sendTemplate: body parameters (no newlines) and an optional document header', async () => {
    const seen = capture(200, { messages: [{ id: 'wamid.T1' }] });
    assert.equal(await wa.sendTemplate('27', {
      name: 'braq_quote_ready', language: 'en', params: ['Thabo', 'BRQ-Q-1\nline 2', ''],
      document: { mediaId: 'M1', filename: 'BRQ-Q-1.pdf' },
    }), 'wamid.T1');
    assert.deepEqual(seen[0], {
      messaging_product: 'whatsapp', recipient_type: 'individual', to: '27', type: 'template',
      template: {
        name: 'braq_quote_ready', language: { code: 'en' },
        components: [
          { type: 'header', parameters: [{ type: 'document', document: { id: 'M1', filename: 'BRQ-Q-1.pdf' } }] },
          { type: 'body', parameters: [{ type: 'text', text: 'Thabo' }, { type: 'text', text: 'BRQ-Q-1 line 2' }, { type: 'text', text: '-' }] },
        ],
      },
    });
  });

  test('sendTemplate errors are wrapped like the other sends', async () => {
    capture(400, metaError);
    await assert.rejects(wa.sendTemplate('27', { name: 'x' }), /WhatsApp template send failed: \{"message"/);
  });
});
