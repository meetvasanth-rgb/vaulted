'use strict';

// Conversations keep their (still end-to-end encrypted) messages on the device
// until deleted, paint from that copy first, then reconcile with the server.
// The rules that decide what may be kept, and what the server can take away,
// are tested here as plain functions; the wiring is pinned below.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

const sandbox = vm.createContext({ Number, Set, Math, Array });
vm.runInContext('const HISTORY_MAX_ENVELOPE_CHARS = 256 * 1024;', sandbox);
for (const name of ['historyEnvelope', 'historyReconcilePlan']) vm.runInContext(extract(client, name), sandbox);
// Values made in the sandbox belong to another realm; round-trip them to plain data.
const run = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression})`, sandbox) ?? 'null');

const base = { type:'message', id:'m1', seq:7, from:'tok', name:'Sam', content:'v:ciphertext', ts:1000,
  deliveredAt:1100, readAt:1200, viewOnce:false, deleteTimerSeconds:0, reactions:{ tok:'👍' }, secretExtra:'x' };
const envelope = message => run(`historyEnvelope(${JSON.stringify(message)})`);

test('an ordinary message is kept as its encrypted envelope, and nothing else about it', () => {
  const kept = envelope(base);
  assert.deepEqual(kept, { id:'m1', seq:7, type:'message', from:'tok', name:'Sam', content:'v:ciphertext',
    ts:1000, deliveredAt:1100, readAt:1200, deleteTimerSeconds:0 });
  assert.equal('reactions' in kept, false);
  assert.equal('secretExtra' in kept, false);
});

test('an attachment message is kept only as its small reference', () => {
  assert.equal(envelope({ ...base, content:'obj:v1:abc-123' }).content, 'obj:v1:abc-123');
});

test('nothing that is meant to disappear is kept on the device', () => {
  assert.equal(envelope({ ...base, viewOnce:true }), null, 'view-once');
  assert.equal(envelope({ ...base, deleteTimerSeconds:60 }), null, 'disappearing timer');
  assert.equal(envelope({ ...base, expiresAt:9999999 }), null, 'server expiry');
  assert.equal(envelope({ ...base, deleted:true }), null, 'deleted for everyone');
});

test('only real, sequenced, encrypted messages are kept', () => {
  assert.equal(envelope({ ...base, type:'system' }), null);
  assert.equal(envelope({ ...base, id:'' }), null);
  assert.equal(envelope({ ...base, content:'' }), null);
  assert.equal(envelope({ ...base, content:null }), null);
  assert.equal(envelope({ ...base, seq:undefined }), null);
  assert.equal(envelope({ ...base, seq:0 }), null);
  assert.equal(envelope({ ...base, content:'x'.repeat(256 * 1024 + 1) }), null, 'oversized envelope');
  assert.equal(vm.runInContext('historyEnvelope(null)', sandbox), null);
});

const plan = args => run(`[...historyReconcilePlan(${JSON.stringify(args)})].sort()`);
const local = [{ id:'a', seq:1, ts:100 }, { id:'b', seq:50, ts:500 }, { id:'c', seq:60, ts:600 }, { id:'d', seq:70, ts:700 }];

test('a message the server no longer has, inside the window it returned, is removed locally', () => {
  const server = [{ id:'c', seq:60 }, { id:'d', seq:70 }];
  assert.deepEqual(plan({ local, serverMessages:server, tombstoneIds:[], clearedAt:0 }), []);
  // the server's window starts at seq 50 and it no longer has c (60): c was deleted or expired
  assert.deepEqual(plan({ local, serverMessages:[{ id:'b', seq:50 }, { id:'d', seq:70 }], tombstoneIds:[], clearedAt:0 }), ['c']);
});

test('messages older than the server window are kept: the server no longer holds them either way', () => {
  const server = [{ id:'c', seq:60 }, { id:'d', seq:70 }];
  assert.equal(plan({ local, serverMessages:server, tombstoneIds:[], clearedAt:0 }).includes('a'), false);
  assert.equal(plan({ local, serverMessages:server, tombstoneIds:[], clearedAt:0 }).includes('b'), false);
});

test('an empty or failed server answer never deletes anything by itself', () => {
  assert.deepEqual(plan({ local, serverMessages:[], tombstoneIds:[], clearedAt:0 }), []);
  assert.deepEqual(plan({ local, serverMessages:undefined, tombstoneIds:undefined, clearedAt:0 }), []);
});

test('a message deleted for everyone is removed, wherever it sits', () => {
  assert.deepEqual(plan({ local, serverMessages:[], tombstoneIds:['a', 'zzz'], clearedAt:0 }), ['a', 'zzz']);
});

test('a chat cleared for everyone removes everything sent up to that moment, and nothing after', () => {
  assert.deepEqual(plan({ local, serverMessages:[{ id:'d', seq:70 }], tombstoneIds:[], clearedAt:600 }), ['a', 'b', 'c']);
});

// ---- wiring ----------------------------------------------------------------

test('every way a message or conversation is removed also removes the stored copy', () => {
  assert.match(client, /function secureNativeDeleteMessage\(conversationId, messageId\) \{\s*if \(!conversationId \|\| !messageId\) return;\s*historyStoreDelete\(conversationId, messageId\);/);
  assert.match(client, /function secureNativeClearConversation\(conversationId\) \{\s*if \(!conversationId\) return;\s*historyStoreClearRoom\(conversationId\);/);
  assert.match(client, /historyStoreWipeAll\(\);\s*\n\s*try \{ sessionStorage\.clear\(\); localStorage\.clear\(\); \}/);
  // the delete ledger and the server's own deletions
  assert.match(client, /historyStoreDelete\(room\.code, msg\.id\); \/\/ gone by the delete ledger/);
  assert.match(client, /for \(const id of remove\) \{\s*historyStoreDelete\(room\.code, id\);/);
});

test('messages are saved as they arrive, are restored, and our own sends are kept', () => {
  assert.match(client, /historyStorePut\(room\.code, data\.messages\); \/\/ keep it on this device until it is deleted/);
  assert.match(client, /historyStorePut\(room\.code, data\.messages\);\s*\n\s*reconcileLocalHistory\(room, localMessages, data\);/);
  assert.match(client, /if \(path === '\/api\/send' && res\.ok && body\?\.ok && data\?\.code\) historyStoreSent\(data, body, rooms\.get\(data\.code\)\);/);
});

test('opening a conversation paints from the device first and only then asks the server', () => {
  const restore = client.slice(client.indexOf('async function restoreRoomHistory(room) {'));
  assert.ok(restore.indexOf('await restoreLocalHistory(room)') < restore.indexOf("api('/api/poll'"), 'local before network');
  assert.match(restore, /if \(data\.error\) throw new Error\(data\.error\);\s*\n\s*const nowTs = Date\.now\(\);\s*\n\s*historyStorePut/);
  // the local pass cannot wait behind attachment downloads: restoring never downloads them
  assert.match(client, /await applyRestoredHistory\(room, stored, Date\.now\(\)\);/);
  assert.doesNotMatch(client, /restoreBatch\(attachmentMessages\)/);
});

test('delivered and read ticks survive on the stored copy', () => {
  assert.match(client, /historyStorePatch\(room\.code, msgId, ticks\)/);
  assert.match(client, /handleReadReceipts\(room, stored\.filter\(message => message\.from === room\.token/);
});

test('a plain store failure never blocks opening a chat', () => {
  assert.match(client, /console\.warn\('Local history could not be restored'/);
  assert.match(client, /request\.onerror = \(\) => resolve\(null\);\s*\n\s*request\.onblocked = \(\) => resolve\(null\);/);
});
