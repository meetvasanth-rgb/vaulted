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
vm.runInContext('const HISTORY_MAX_ENVELOPE_CHARS = 256 * 1024; const HISTORY_LOAD_LIMIT = 50;', sandbox);
for (const name of ['historyEnvelope', 'historyReconcilePlan', 'historyRestoreSyncPlan']) vm.runInContext(extract(client, name), sandbox);
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

test('cached history resumes with a delta while a fresh device requests only a 50-message bootstrap', () => {
  const room = { code:'room', token:'token', lastReceiptSeq:8, lastReadReceiptSeq:7, lastReactionSeq:6, lastDeletionSeq:5 };
  const delta = run(`historyRestoreSyncPlan(${JSON.stringify(room)}, [{id:'a',seq:40},{id:'b',seq:44}])`);
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.request.lastSeq, 44);
  assert.equal(delta.request.lastReceiptSeq, 8);
  assert.equal('full' in delta.request, false);

  const bootstrap = run(`historyRestoreSyncPlan(${JSON.stringify(room)}, [])`);
  assert.equal(bootstrap.mode, 'bootstrap');
  assert.equal(bootstrap.request.lastSeq, 0);
  assert.equal(bootstrap.request.full, 1);
  assert.equal(bootstrap.request.bootstrapLimit, 50);
});

test('native records carrying their server cursor resume with a delta', () => {
  const room = { code:'room', token:'token', lastReceiptSeq:8, lastReadReceiptSeq:7, lastReactionSeq:6, lastDeletionSeq:5 };
  const delta = run(`historyRestoreSyncPlan(${JSON.stringify(room)}, [{id:'a',serverSeq:51},{id:'b',serverSeq:54}])`);
  assert.equal(delta.mode, 'delta');
  assert.equal(delta.request.lastSeq, 54);
  assert.equal('full' in delta.request, false);
});

// ---- wiring ----------------------------------------------------------------

test('every way a message or conversation is removed also removes the stored copy', () => {
  assert.match(client, /historyStoreDelete\(code, id\), eraseNativeMessage\(code, id\)/);
  const clearNative = extract(client, 'secureNativeClearConversation');
  assert.match(clearNative, /historyStoreClearRoom\(conversationId\);/);
  assert.match(clearNative, /conversationLayouts\.delete\(conversationId\);/);
  assert.match(client, /historyStoreWipeAll\(\);\s*\n\s*try \{ sessionStorage\.clear\(\); localStorage\.clear\(\); \}/);
  // the delete ledger and the server's own deletions
  assert.match(client, /function eraseExpiredMessageCopies[\s\S]*historyStoreDelete\(room\.code, msgId\)/);
  assert.match(client, /ledgerDeleteAt && ledgerDeleteAt <= nowTs\) \{\s*eraseExpiredMessageCopies\(room, msg\.id/);
  assert.match(client, /for \(const id of remove\) \{\s*historyStoreDelete\(room\.code, id\);/);
});

test('messages are saved as they arrive, are restored, and our own sends are kept', () => {
  assert.match(client, /historyStorePut\(room\.code, data\.messages\); \/\/ keep it on this device until it is deleted/);
  assert.match(client, /historyStorePut\(room\.code, data\.messages\);\s*\n\s*if \(syncPlan\.mode === 'bootstrap'\) reconcileLocalHistory\(room, localMessages, data\);/);
  assert.match(client, /if \(path === '\/api\/send' && res\.ok && body\?\.ok && data\?\.code\) historyStoreSent\(data, body, rooms\.get\(data\.code\)\);/);
});

test('opening a conversation paints from the device first and only then asks the server', () => {
  const restore = client.slice(client.indexOf('async function restoreRoomHistory(room) {'));
  assert.ok(restore.indexOf('await restoreLocalHistory(room)') < restore.indexOf("api('/api/poll'"), 'local before network');
  assert.match(restore, /const syncPlan = historyRestoreSyncPlan\(room, localMessages\);\s*\n\s*const data = await api\('\/api\/poll', syncPlan\.request\);/);
  assert.match(restore, /if \(data\.error\) throw new Error\(data\.error\);\s*\n\s*const nowTs = Date\.now\(\);\s*\n\s*await repairRoomKeyFromAccountBackup\(room, data\.messages\);\s*\n\s*historyStorePut/);
  // the local pass cannot wait behind attachment downloads: restoring never downloads them
  assert.match(client, /await applyRestoredHistory\(room, stored, Date\.now\(\), \{ deferAttachmentRender:isNativeApp\(\) \}\);/);
  assert.doesNotMatch(client, /restoreBatch\(attachmentMessages\)/);
});

test('a historic clear watermark removes only older cached messages and survives restart', () => {
  assert.match(client, /for \(const message of localMessages\) \{\s*if \(!\(Number\(message\.ts\) > 0 && Number\(message\.ts\) <= cutoff\)\) continue;/);
  assert.match(client, /lastKnownClearedAt:Math\.max\(0, Number\(room\.lastKnownClearedAt\) \|\| 0\)/);
  assert.match(client, /existing\.lastKnownClearedAt = Math\.max\(0, Number\(room\.lastKnownClearedAt\) \|\| 0\);/);
  assert.match(client, /lastKnownClearedAt:session\.lastKnownClearedAt/);
});

test('delivered and read ticks survive on the stored copy', () => {
  assert.match(client, /historyStorePatch\(room\.code, msgId, ticks\)/);
  assert.match(client, /restoreOwnTicks\(room, stored\);/);
  assert.match(client, /function restoreOwnTicks\(room, messages\) \{\s*handleReadReceipts\(room, messages\.filter\(message => message\.from === room\.token/);
});

test('a plain store failure never blocks opening a chat', () => {
  assert.match(client, /console\.warn\('Local history could not be restored'/);
  assert.match(client, /request\.onerror = \(\) => resolve\(null\);\s*\n\s*request\.onblocked = \(\) => resolve\(null\);/);
});
