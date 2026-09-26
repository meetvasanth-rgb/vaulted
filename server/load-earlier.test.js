'use strict';

// "Load earlier messages": a conversation opens with its newest 200 messages; a
// button at the top adds older ones, first from this device's saved history and
// then from the server's full history, without moving the reader.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('the saved history can be read a page at a time, newest first, through a (conversation, seq) index', () => {
  assert.match(client, /indexedDB\.open\(HISTORY_DB_NAME, 3\)/);
  assert.match(client, /if \(!messages\.indexNames\.contains\('byRoomSeq'\)\) messages\.createIndex\('byRoomSeq', \['code', 'seq'\]\);/);
  assert.match(client, /const messages = db\.objectStoreNames\.contains\('messages'\)\s*\n\s*\? request\.transaction\.objectStore\('messages'\)/);
  assert.match(client, /index\('byRoomSeq'\)\.openCursor\(range, 'prev'\)/);
  // one extra row tells whether older messages remain
  assert.match(client, /if \(cursor && rows\.length <= limit\)/);
  assert.match(client, /hasMore:rows\.length > limit/);
  assert.match(client, /IDBKeyRange\.bound\(\[code, 0\], \[code, bounded \? beforeSeq : Number\.MAX_SAFE_INTEGER\], false, bounded\)/);
});

test('a chat opens with 200 messages and each page adds 200 from the device or 50 from the server', () => {
  assert.match(client, /const HISTORY_LOAD_LIMIT = 200;/);
  assert.match(client, /const HISTORY_PAGE_SIZE = 200;/);
  assert.match(client, /const SERVER_HISTORY_PAGE_SIZE = 50;/);
  assert.match(client, /async function historyStoreLoad\(code\) \{\s*return \(await historyStoreLoadPage\(code\)\)\.messages;/);
});

test('how far back a conversation has been loaded is tracked from every restore', () => {
  assert.match(client, /if \(seq > 0 && !\(seq >= room\.historyOldestSeq\)\) room\.historyOldestSeq = seq;/);
  assert.match(client, /room\.historyOldestSeq = undefined;\s*\n\s*room\.historyEarlierExhausted = false;/);
});

test('the button sits at the top of the chat only while there may be older messages', () => {
  assert.match(client, /if \(room\.historyOldestSeq > 1 && !room\.historyEarlierExhausted\) \{/);
  assert.match(client, /more\.querySelector\('button'\)\.onclick = \(\) => loadEarlierMessages\(room\);/);
  assert.match(client, /body\.insertBefore\(more, body\.querySelector\('#typing-indicator'\)\);/);
  assert.match(client, /Load earlier messages/);
});

test('earlier messages come from this device first, then from the server, and are saved locally', () => {
  const loader = client.slice(client.indexOf('async function loadEarlierMessages(room)'), client.indexOf('// After the server answers, drop local messages'));
  assert.ok(loader.indexOf('historyStoreLoadPage(room.code') < loader.indexOf("api('/api/history'"), 'device before server');
  assert.match(loader, /beforeSeq:before, limit:SERVER_HISTORY_PAGE_SIZE/);
  assert.match(loader, /historyStorePut\(room\.code, messages\)/);
  assert.match(loader, /applyRestoredHistory\(room, messages, Date\.now\(\), \{ confirmReads:false \}\)/);
  assert.match(loader, /restoreOwnTicks\(room, messages\)/);
});

test('loading older messages never sends read receipts for them', () => {
  assert.match(client, /async function applyRestoredHistory\(room, messages, nowTs, \{ confirmReads = true \} = \{\}\)/);
  assert.match(client, /else if \(!rec\.isMe && msg\.type === 'message' && confirmReads\) \{/);
  assert.match(client, /else if \(!placeholder\.isMe && confirmReads\) \{/);
});

test('the reader keeps their place: older messages are added above without moving the view', () => {
  assert.match(client, /function renderChatBody\(room, \{ keepDistanceFromBottom = null \} = \{\}\)/);
  assert.match(client, /body\.scrollTop = keepPlace \? Math\.max\(0, body\.scrollHeight - body\.clientHeight - keepDistanceFromBottom\) : body\.scrollHeight;/);
  assert.match(client, /if \(!keepPlace && !keptReaderPlace\) requestAnimationFrame\(\(\) => \{/);
  assert.match(client, /renderChatBody\(room, \{ keepDistanceFromBottom:distanceFromBottom \}\)/);
});

test('the button stops being offered when nothing older exists, and survives a failed request', () => {
  assert.match(client, /const progressed = messages\.length > 0 && room\.historyOldestSeq < before;/);
  assert.match(client, /if \(!progressed \|\| \(fromServer && !serverHasMore\)\) room\.historyEarlierExhausted = true;/);
  assert.match(client, /toast\('No earlier messages'\)/);
  assert.match(client, /toast\('Could not load earlier messages\. Check your connection and try again\.'\)/);
  assert.match(client, /again\.disabled = false; again\.textContent = 'Load earlier messages';/);
  assert.match(client, /if \(!room \|\| room\.loadingEarlier \|\| !\(before > 1\)\) return;/);
});
