'use strict';

// Private group attachments are saved on the device, in the same store as
// one-to-one downloads, under `group:<id>`. Opening a group again must read
// them from there; a deleted attachment must never be fetched or kept.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const groups = read('client/groups.js');
const client = read('client/index.html');

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
const fn = name => extract(groups, name);
const asyncFn = name => extract(groups, name, 'async function');

function makeSandbox({ cache = new Map(), fetchImpl } = {}) {
  const calls = { fetch:0, put:[], del:[], clear:[] };
  const sandbox = vm.createContext({
    Map, Set, String, Array, JSON, Blob, Promise, Object, Number, Error, setTimeout, clearTimeout, AbortController,
    MAX_PRIVATE_GROUP_ATTACHMENT_BYTES:48 * 1024 * 1024,
    ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS:[0, 1, 1, 1], ATTACHMENT_STALL_MS:1000,
    readAttachmentBody:response => response.text(),
    attachmentCacheGet:async (code, id) => cache.get(`${code}|${id}`) ?? null,
    attachmentCachePut:async (code, id, msgId, text) => { calls.put.push([code, id, msgId]); cache.set(`${code}|${id}`, text); return true; },
    historyStoreDelete:(code, id) => calls.del.push([code, id]),
    historyStoreClearRoom:code => { calls.clear.push(code); },
    fetch:async (...args) => { calls.fetch++; return fetchImpl(...args); },
  });
  vm.runInContext(fn('privateGroupCacheCode'), sandbox);
  vm.runInContext('const privateGroupDownloads = new Map();', sandbox);
  vm.runInContext(fn('forgetPrivateGroupData'), sandbox);
  vm.runInContext(fn('downloadPrivateGroupAttachment'), sandbox);
  vm.runInContext(asyncFn('fetchPrivateGroupAttachment'), sandbox);
  vm.runInContext(fn('privateGroupDeletedIds'), sandbox);
  vm.runInContext(asyncFn('decodePrivateGroupBatch'), sandbox);
  return { sandbox, calls, cache };
}

const state = { accountId:'me', sessionToken:'t' };
const group = { id:'g1' };
const ok = text => ({ ok:true, status:200, text:async () => text });

test('the first open downloads and saves under group:<id>, tied to the message', async () => {
  const { sandbox, calls } = makeSandbox({ fetchImpl:async () => ok('CIPHERTEXT') });
  Object.assign(sandbox, { state, group });
  const text = await vm.runInContext("downloadPrivateGroupAttachment(state, group, 'att1', 'msg1')", sandbox);
  assert.equal(text, 'CIPHERTEXT');
  assert.equal(calls.fetch, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.put)), [['group:g1', 'att1', 'msg1']]);
});

test('a saved attachment opens without any network request', async () => {
  const cache = new Map([['group:g1|att1', 'SAVED']]);
  const { sandbox, calls } = makeSandbox({ cache, fetchImpl:async () => { throw new Error('offline'); } });
  Object.assign(sandbox, { state, group });
  assert.equal(await vm.runInContext("downloadPrivateGroupAttachment(state, group, 'att1', 'msg1')", sandbox), 'SAVED');
  assert.equal(calls.fetch, 0);
});

test('two callers asking for the same attachment share one download', async () => {
  const { sandbox, calls } = makeSandbox({ fetchImpl:async () => ok('X') });
  Object.assign(sandbox, { state, group });
  const [a, b] = await Promise.all([
    vm.runInContext("downloadPrivateGroupAttachment(state, group, 'att1', 'm')", sandbox),
    vm.runInContext("downloadPrivateGroupAttachment(state, group, 'att1', 'm')", sandbox),
  ]);
  assert.equal(a, 'X'); assert.equal(b, 'X');
  assert.equal(calls.fetch, 1);
});

test('a flaky connection is retried, a refusal is not', async () => {
  let n = 0;
  const flaky = makeSandbox({ fetchImpl:async () => (++n < 3 ? { ok:false, status:503 } : ok('OK')) });
  Object.assign(flaky.sandbox, { state, group });
  assert.equal(await vm.runInContext("downloadPrivateGroupAttachment(state, group, 'a', 'm')", flaky.sandbox), 'OK');
  assert.equal(flaky.calls.fetch, 3);

  const refused = makeSandbox({ fetchImpl:async () => ({ ok:false, status:403 }) });
  Object.assign(refused.sandbox, { state, group });
  await assert.rejects(vm.runInContext("downloadPrivateGroupAttachment(state, group, 'a', 'm')", refused.sandbox));
  assert.equal(refused.calls.fetch, 1);
  assert.equal(refused.calls.put.length, 0);
});

test('a failed download saves nothing, so the next open tries again', async () => {
  const { sandbox, calls } = makeSandbox({ fetchImpl:async () => { throw new Error('network'); } });
  Object.assign(sandbox, { state, group });
  await assert.rejects(vm.runInContext("downloadPrivateGroupAttachment(state, group, 'a', 'm')", sandbox));
  assert.equal(calls.put.length, 0);
  assert.equal(vm.runInContext('privateGroupDownloads.size', sandbox), 0);
});

test('forgetting a group clears exactly its saved history and downloads', () => {
  const { sandbox, calls } = makeSandbox({ fetchImpl:async () => ok('') });
  vm.runInContext("forgetPrivateGroupData('g9')", sandbox);
  assert.deepEqual(JSON.parse(JSON.stringify(calls.clear)), ['group:g9']);
});

test('deleted ids: only the sender can delete for everyone, and hidden ids count', () => {
  const { sandbox } = makeSandbox({ fetchImpl:async () => ok('') });
  const run = (messages, hidden) => JSON.parse(vm.runInContext(
    `JSON.stringify([...privateGroupDeletedIds(${JSON.stringify(messages)}, ${JSON.stringify(hidden)})].sort())`, sandbox));
  const msgs = [
    { id:'m1', senderId:'a' }, { id:'m2', senderId:'a' }, { id:'m3', senderId:'b' },
    { id:'c1', senderId:'a', control:{ type:'delete', target:'m1' } },
    { id:'c2', senderId:'b', control:{ type:'delete', target:'m2' } }, // b cannot delete a's message
    { id:'c3', senderId:'b', control:{ type:'reaction', target:'m3', emoji:'👍' } },
  ];
  assert.deepEqual(run(msgs, []), ['m1']);
  assert.deepEqual(run(msgs, ['m3']), ['m1', 'm3']);
});

test('a batch never keeps a deleted attachment, and turns the rest into placeholders without downloading', async () => {
  const { sandbox, calls } = makeSandbox({ fetchImpl:async () => ok('') });
  const downloaded = [];
  Object.assign(sandbox, {
    state, group:{ id:'g1', messages:[], hiddenIds:['hiddenAtt'] },
    decodePrivateGroupEnvelope:async (g, message) => {
      if (message.kind === 'text') return { decoded:{ id:message.id, senderId:message.senderId, text:'hi' } };
      if (message.kind === 'delete') return { decoded:{ id:message.id, senderId:message.senderId, control:{ type:'delete', target:message.target } } };
      return { pending:{ message, attachmentId:`att-${message.id}` } };
    },
    decodePrivateGroupAttachment:async (g, s, message) => { downloaded.push(message.id); return {}; },
  });
  const batch = [
    { id:'t1', senderId:'a', kind:'text' },
    { id:'a1', senderId:'a', kind:'att' }, { id:'a2', senderId:'b', kind:'att' },
    { id:'gone', senderId:'a', kind:'att' }, { id:'hiddenAtt', senderId:'b', kind:'att' },
    { id:'d1', senderId:'a', kind:'delete', target:'gone' },
  ];
  const decoded = JSON.parse(JSON.stringify(await vm.runInContext(`decodePrivateGroupBatch(group, state, ${JSON.stringify(batch)})`, sandbox)));
  assert.deepEqual(downloaded, [], 'nothing is downloaded until an attachment scrolls into view');
  assert.equal(calls.fetch, 0);
  const placeholders = decoded.filter(item => item.attachmentState);
  assert.deepEqual(placeholders.map(item => [item.id, item.attachmentId, item.attachmentState]),
    [['a1', 'att-a1', 'loading'], ['a2', 'att-a2', 'loading']]);
  assert.equal(decoded.length, 1 + 1 + 2); // text, delete control, two placeholders
  assert.deepEqual(calls.del.map(x => x[1]).sort(), ['gone', 'hiddenAtt']);
  assert.ok(calls.del.every(x => x[0] === 'group:g1'));
});

test('wiring: uploads are kept, deletes and leaving clean up, Storage names groups', () => {
  assert.match(groups, /attachmentCachePut\(privateGroupCacheCode\(group\.id\), attachmentId, messageId, encryptedPayload\)/);
  assert.match(groups, /downloadPrivateGroupAttachment\(state, group, attachmentId, message\.id, options\)/);
  assert.match(extract(groups, 'deletePrivateGroupMessages', 'async function'), /historyStoreDelete\(privateGroupCacheCode\(group\.id\), id\)/);
  assert.equal((groups.match(/forgetPrivateGroupData\(/g) || []).length, 5); // definition + leave + delete + report + sync prune
  assert.match(groups, /if \(!live\.has\(id\)\) \{ forgetPrivateGroupData\(id\)/);
  assert.match(extract(groups, 'pollPrivateGroup', 'async function'), /decodePrivateGroupBatch\(group, state, incomingRaw\)/);
  assert.match(client, /function storageLabelForCode\(code\)/);
  assert.match(client, /startsWith\('group:'\)/);
});

test('the service worker cache was bumped for this change', () => {
  const version = Number(/vaultlix-app-shell-v(\d+)/.exec(read('client/sw.js'))[1]);
  assert.ok(version >= 74);
});
