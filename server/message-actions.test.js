'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('text-message long press opens actions without the release click closing them', () => {
  assert.match(client, /const textBubble = div\.querySelector\('\.bubble'\)/);
  assert.match(client, /if \(textBubble\) attachLongPress\(textBubble, msgId\)/);
  assert.match(client, /if \(wasJustLongPressed\(\)\) return;\s*handleTap\(\);/);
});

test('reply action starts a reply before closing the message actions', () => {
  assert.match(client, /actions\.querySelector\('\[data-action="reply"\]'\)\.onclick = \(e\) => \{\s*e\.stopPropagation\(\);\s*startReply\(rec, msgId, replyText\);\s*closeAllMsgActions\(\);/s);
  assert.match(client, /document\.getElementById\('reply-preview'\)\.classList\.add\('show'\)/);
});
