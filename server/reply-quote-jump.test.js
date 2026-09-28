'use strict';

// Long-pressing a message and replying to it (1:1 chat) shows a quote of the
// original above the new message. Tapping that quote should jump to and
// flash the original message — it previously did nothing, because the
// target message's id was captured when the reply was composed but silently
// dropped before it ever reached the sent payload or the rendered quote.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

function extract(source, name, keyword = 'function') {
  const start = source.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('startReply captures the target message id (already worked — this is the source of truth the rest of the fix relies on)', () => {
  const fn = extract(client, 'startReply');
  assert.match(fn, /replyTo = \{\s*msgId,/);
});

test('the outgoing reply snapshot includes msgId for an ordinary (non-status) reply', () => {
  const idx = client.indexOf("replySnapshot = replyTo.type === 'status'");
  assert.notEqual(idx, -1, 'replySnapshot construction missing');
  const snippet = client.slice(idx, idx + 500);
  assert.match(snippet, /:\s*\{\s*msgId:\s*replyTo\.msgId\s*\|\|\s*null,\s*text:\s*replyTo\.text/);
});

test('the decoded reply payload preserves msgId from the peer, bounds-checked like every other reply field', () => {
  const idx = client.indexOf("const replyData = statusReply || {");
  assert.notEqual(idx, -1, 'decode-side replyData reconstruction missing');
  const snippet = client.slice(idx, idx + 400);
  assert.match(snippet, /msgId:typeof parsed\.reply\.msgId === 'string' && parsed\.reply\.msgId\.length <= 120 \? parsed\.reply\.msgId : null/);
});

test('both reply-quote render paths (plain text and image/video) emit data-reply-to when msgId is present', () => {
  assert.match(client, /<div class="msg-reply-quote"\$\{rec\.replyData\.msgId \? ` data-reply-to="\$\{escHtml\(rec\.replyData\.msgId\)\}"` : ''\}>/);
  const photoFn = extract(client, 'buildReplyQuotePhotoHtml');
  assert.match(photoFn, /msg-reply-quote-photo"\$\{replyData\.msgId \? ` data-reply-to="\$\{escHtml\(replyData\.msgId\)\}"` : ''\}>/);
});

test('the reply quote is wired to jump to (and flash) the original message, mirroring the group chat', () => {
  const wire = extract(client, 'wireMsgActions');
  assert.match(wire, /const quote = div\.querySelector\('\[data-reply-to\]'\);/);
  assert.match(wire, /quote\.onclick = e => \{ if \(!selectMode\) \{ e\.stopPropagation\(\); jumpToMessage\(quote\.dataset\.replyTo\); \} \};/);

  const jump = extract(client, 'jumpToMessage');
  assert.match(jump, /document\.querySelector\(`#chat-body \.msg\[data-msg-id="\$\{CSS\.escape\(id\)\}"\]`\)/);
  assert.match(jump, /toast\('That message is no longer on this device'\)/);
  assert.match(jump, /scrollIntoView\(\{ block:'center', behavior:'smooth' \}\)/);
  assert.match(jump, /classList\.add\('flash'\)/);
});

test('a flash highlight animation exists for the target bubble (direct chat had none before, unlike the group chat)', () => {
  assert.match(client, /\.msg\.flash \.bubble\{animation:msg-flash 1\.2s ease\}/);
  assert.match(client, /@keyframes msg-flash\{0%,60%\{box-shadow:0 0 0 3px #c87588\}100%\{box-shadow:none\}\}/);
});
