const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

function functionSource(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('inbox activity never parses a formatted clock label as a number', () => {
  const activity = functionSource(client, 'vaultLastActivity');
  assert.doesNotMatch(activity, /Number\(last\?\.time/);
  assert.match(activity, /new Date\(last\?\.ts \|\| 0\)\.getTime\(\) \|\| 0/);
  assert.match(activity, /filter\(isVisibleConversationRecord\)/);
  assert.match(server, /room\.lastMessageAt = Math\.max\(Number\(room\.lastMessageAt\) \|\| 0, durableLastMessageAt\)/);
});

test('only encrypted call history is rendered as a conversation system chip', () => {
  const visibility = functionSource(client, 'isVisibleConversationRecord');
  assert.match(visibility, /Encrypted call/);
  assert.match(visibility, /Missed/);
  assert.match(visibility, /Cancel/);
  assert.match(functionSource(client, 'renderMessageRecord'), /if \(!isVisibleConversationRecord\(rec\)\) return null/);
  assert.match(functionSource(client, 'vaultInboxPreview'), /filter\(isVisibleConversationRecord\)/);

  assert.doesNotMatch(server, /type:'system', content:`\$\{name\} joined`/);
  assert.doesNotMatch(server, /type:'system', content:`\$\{m\.name\} left`/);
  assert.doesNotMatch(server, /type:'system', content:`\$\{m\.name\} cleared the chat`/);
});

test('decrypted history retains the server timestamp used by inbox ordering', () => {
  assert.match(client, /processIncomingContent\(room, msg\.content, msg\.name, formatMsgTime\(msg\.ts\), msg\.id, msg\.ts\)/);
  assert.match(client, /ts:Number\(timestamp\) \|\| 0/);
  assert.match(client, /pendingDecrypt\.push\(\{ msgId: msg\.id, content: msg\.content, name: msg\.name, time: formatMsgTime\(msg\.ts\), ts:msg\.ts \}\)/);
});
