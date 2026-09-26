'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('text-message long press selects the message without the release click undoing it', () => {
  assert.match(client, /const textBubble = div\.querySelector\('\.bubble'\)/);
  assert.match(client, /if \(textBubble\) attachLongPress\(textBubble, msgId\)/);
  assert.match(client, /if \(wasJustLongPressed\(\)\) return;\s*if \(selectMode\) toggleMessageSelection\(msgId\);/);
  assert.match(client, /else if \(selectMode\) toggleMessageSelection\(msgId\); else enterSelectMode\(msgId\);/);
});

test('reply starts a reply after ending the selection', () => {
  assert.match(client, /reply\(\) \{\s*const one = chosen\(\)\[0\]; if \(!one\) return;\s*exitSelectMode\(\);\s*startReply\(one\.entry\.rec, one\.id, one\.entry\.replyText\);/);
  assert.match(client, /document\.getElementById\('reply-preview'\)\.classList\.add\('show'\)/);
});

test('PDF cards support long-press selection, with reply and forward on the bar', () => {
  assert.match(client, /const media = div\.querySelector\('[^']*\.msg-pdf-card[^']*'\)/);
  assert.match(client, /\.msg-image,\.msg-file,\.msg-pdf-card,\.msg-viewonce\{-webkit-touch-callout:none/);
  assert.match(client, /return !!rec && \['file', 'album', 'text'\]\.includes\(rec\.kind\) && !rec\.viewOnce;/);
  assert.match(client, /startReply\(one\.entry\.rec, one\.id, one\.entry\.replyText\)/);
  assert.match(client, /showForwardAttachmentPicker\(rec\.kind === 'text' \? \{ kind: 'text', text: one\.entry\.replyText \} : rec\)/);
});
