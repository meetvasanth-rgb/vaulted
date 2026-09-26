'use strict';

// Private group history is kept on the device (still encrypted, in the shared
// IndexedDB store under `group:<id>`), so a group opens with its conversation
// in place, works offline, and can page back through what it has saved.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');

function extract(name, keyword = 'function') {
  const start = groups.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = groups.indexOf('{', groups.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < groups.length; i++) {
    if (groups[i] === '{') depth++;
    else if (groups[i] === '}' && --depth === 0) return groups.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function load(overrides = {}) {
  const log = { puts:[], loadPage:[], api:[], renders:0, toasts:[] };
  const sandbox = vm.createContext({
    Map, Set, String, Array, JSON, Promise, Object, Number, Math, Infinity,
    HISTORY_LOAD_LIMIT:200,
    activePrivateGroupId:'g1',
    privateGroups:new Map(),
    loadAccountState:() => ({ accountId:'me', sessionToken:'t' }),
    hasPrivateGroupKeys:() => true,
    toast:message => log.toasts.push(message),
    document:{ getElementById:() => null, querySelector:() => null },
    renderPrivateGroupMessages:() => { log.renders++; },
    historyTransaction:async (mode, work) => { const store = { put:row => log.puts.push(row) }; work(store); return true; },
    historyStoreLoadPage:async (code, options) => { log.loadPage.push([code, options]); return overrides.page ? overrides.page(code, options) : { messages:[], hasMore:false }; },
    decodePrivateGroupBatch:async (group, state, raws) => raws.map(raw => ({ ...raw, text:`t-${raw.id}` })),
    api:async (url, body) => { log.api.push([url, body]); return overrides.api ? overrides.api(url, body) : { ok:true, messages:[], cursor:0 }; },
  });
  vm.runInContext('function privateGroupCacheCode(groupId) { return `group:${groupId}`; }', sandbox);
  vm.runInContext(groups.match(/const PRIVATE_GROUP_HISTORY_PAGE = \d+;/)[0], sandbox);
  vm.runInContext(groups.match(/const PRIVATE_GROUP_HISTORY_MAX_CHARS = [^;]+;/)[0], sandbox);
  vm.runInContext('const privateGroupRestores = new Map();', sandbox);
  for (const name of ['privateGroupHistoryEnvelope', 'privateGroupHistoryPut', 'mergePrivateGroupMessages', 'privateGroupOldestCreatedAt',
    'privateGroupCanLoadEarlier', 'restorePrivateGroupHistory']) vm.runInContext(extract(name), sandbox);
  for (const name of ['pollPrivateGroup', 'loadEarlierPrivateGroupMessages']) vm.runInContext(extract(name, 'async function'), sandbox);
  return { sandbox, log };
}
const plain = value => JSON.parse(JSON.stringify(value));
const raw = (id, createdAt, extra = {}) => ({ id, senderId:'a', ciphertext:`c-${id}`, keyVersion:1, createdAt, ...extra });

test('only well-formed server messages are saved, and only their encrypted form', () => {
  const { sandbox } = load();
  const env = message => plain(vm.runInContext(`privateGroupHistoryEnvelope(${JSON.stringify(message)})`, sandbox));
  assert.deepEqual(env({ ...raw('m1', 5), extra:'dropped', text:'plaintext must not sneak in' }), raw('m1', 5));
  assert.equal(env({ ...raw('m1', 5), ciphertext:'' }), null);
  assert.equal(env({ ...raw('m1', 5), ciphertext:'x'.repeat(256 * 1024 + 1) }), null);
  assert.equal(env({ ...raw('m1', 0) }), null);
  assert.equal(env({ ...raw('m1', 5), senderId:'' }), null);
  assert.equal(env({ ...raw('x'.repeat(97), 5) }), null);
  assert.equal(env(null), null);
});

test('saved rows are keyed by group and ordered by the server time', async () => {
  const { sandbox, log } = load();
  await vm.runInContext(`privateGroupHistoryPut('g1', ${JSON.stringify([raw('m1', 10), raw('m2', 20), { id:'bad' }])})`, sandbox);
  assert.deepEqual(plain(log.puts).map(row => [row.code, row.id, row.seq]), [['group:g1', 'm1', 10], ['group:g1', 'm2', 20]]);
  assert.equal(await vm.runInContext("privateGroupHistoryPut('g1', [])", sandbox), false);
});

test('merging never repeats a message, keeps order, and honours the window', () => {
  const { sandbox } = load();
  const run = (group, incoming) => plain(vm.runInContext(`(() => { const g = ${JSON.stringify(group)}; const n = mergePrivateGroupMessages(g, ${JSON.stringify(incoming)}); return { n, ids:g.messages.map(m => m.id) }; })()`, sandbox));
  assert.deepEqual(run({ messages:[{ id:'b', createdAt:2 }] }, [{ id:'a', createdAt:1 }, { id:'b', createdAt:2 }, { id:'c', createdAt:3 }]), { n:2, ids:['a', 'b', 'c'] });
  const many = Array.from({ length:250 }, (_, i) => ({ id:`m${i}`, createdAt:i + 1 }));
  assert.equal(run({ messages:[] }, many).ids.length, 200);
  assert.equal(run({ messages:[], messageWindow:300 }, many).ids.length, 250);
});

test('the oldest saved time ignores messages that have not been sent yet', () => {
  const { sandbox } = load();
  const oldest = messages => vm.runInContext(`privateGroupOldestCreatedAt({ messages:${JSON.stringify(messages)} })`, sandbox);
  assert.equal(oldest([{ createdAt:30 }, { createdAt:10 }, { createdAt:5, pending:true }]), 10);
  assert.equal(oldest([]), 0);
});

test('opening a group paints its saved history and resumes from the newest saved message', async () => {
  const stored = [raw('m1', 10), raw('m2', 20), raw('m3', 30)];
  const { sandbox, log } = load({ page:() => ({ messages:stored, hasMore:true }) });
  const group = { id:'g1', messages:[], hiddenIds:[] };
  Object.assign(sandbox, { group, state:{ accountId:'me' } });
  await vm.runInContext('restorePrivateGroupHistory(group, state)', sandbox);
  assert.deepEqual(plain(group.messages).map(m => m.id), ['m1', 'm2', 'm3']);
  assert.equal(group.messageCursor, 30);
  assert.equal(group.historyHydrated, true);
  assert.equal(group.localHasMore, true);
  assert.equal(log.renders, 1);
  assert.deepEqual(plain(log.loadPage[0]), ['group:g1', { limit:200 }]);
  await vm.runInContext('restorePrivateGroupHistory(group, state)', sandbox);
  assert.equal(log.loadPage.length, 1, 'restoring twice reads the store once');
});

test('a group with nothing saved is not marked ready until the server answers', async () => {
  const { sandbox } = load();
  const group = { id:'g1', messages:[] };
  Object.assign(sandbox, { group, state:{ accountId:'me' } });
  await vm.runInContext('restorePrivateGroupHistory(group, state)', sandbox);
  assert.equal(group.historyRestored, true);
  assert.ok(!group.historyHydrated);
});

test('the poll saves what the server sent (encrypted), resumes from the cursor and remembers hasOlder', async () => {
  const stored = [raw('m1', 10)];
  const { sandbox, log } = load({
    page:() => ({ messages:stored, hasMore:false }),
    api:() => ({ ok:true, cursor:40, hasOlder:true, messages:[raw('m2', 40)] }),
  });
  const group = { id:'g1', messages:[], hiddenIds:[] };
  sandbox.privateGroups.set('g1', group);
  assert.equal(await vm.runInContext("pollPrivateGroup(false, 'g1')", sandbox), true);
  const [, request] = plain(log.api[0]);
  assert.equal(request.after, 10);
  assert.equal(request.oldest, 10);
  assert.deepEqual(plain(log.puts).map(row => row.id), ['m2']);
  assert.deepEqual(plain(group.messages).map(m => m.id), ['m1', 'm2']);
  assert.equal(group.messageCursor, 40);
  assert.equal(group.hasOlder, true);
});

test('offline with history on screen is still a usable group; with nothing it is not', async () => {
  const offline = { error:'network' };
  const withHistory = load({ page:() => ({ messages:[raw('m1', 10)], hasMore:false }), api:() => offline });
  const groupA = { id:'g1', messages:[], hiddenIds:[] };
  withHistory.sandbox.privateGroups.set('g1', groupA);
  assert.equal(await vm.runInContext("pollPrivateGroup(false, 'g1')", withHistory.sandbox), true);
  assert.equal(groupA.messages.length, 1);

  const empty = load({ api:() => offline });
  empty.sandbox.privateGroups.set('g1', { id:'g1', messages:[] });
  assert.equal(await vm.runInContext("pollPrivateGroup(false, 'g1')", empty.sandbox), false);
});

test('a group without its key never touches the store or the cursor', async () => {
  const { sandbox, log } = load();
  sandbox.hasPrivateGroupKeys = () => false;
  const group = { id:'g1', messages:[] };
  sandbox.privateGroups.set('g1', group);
  assert.equal(await vm.runInContext("pollPrivateGroup(false, 'g1')", sandbox), false);
  assert.equal(log.loadPage.length, 0); assert.equal(log.api.length, 0); assert.ok(!group.messageCursor);
});

test('load earlier: this device first, then the server, then it stops', async () => {
  let pages = [{ messages:[raw('m3', 30), raw('m4', 40)], hasMore:true }, { messages:[], hasMore:false }];
  const { sandbox, log } = load({
    page:() => pages.shift(),
    api:(url, body) => ({ ok:true, hasOlder:false, messages:body.before === 30 ? [raw('m1', 10), raw('m2', 20)] : [] }),
  });
  const group = { id:'g1', messages:[{ id:'m5', createdAt:50 }], localHasMore:false, hasOlder:true };
  sandbox.privateGroups.set('g1', group);
  await vm.runInContext("loadEarlierPrivateGroupMessages('g1')", sandbox);
  assert.deepEqual(plain(group.messages).map(m => m.id), ['m3', 'm4', 'm5']);
  assert.equal(group.localHasMore, true);
  assert.equal(log.api.length, 0, 'the server is not asked while the device still has older messages');
  assert.deepEqual(plain(log.loadPage[0]), ['group:g1', { beforeSeq:50, limit:100 }]);

  pages = [{ messages:[], hasMore:false }];
  await vm.runInContext("loadEarlierPrivateGroupMessages('g1')", sandbox);
  assert.equal(plain(log.api[0])[1].before, 30);
  assert.deepEqual(plain(group.messages).map(m => m.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  assert.ok(group.messageWindow >= 5);
  assert.deepEqual(plain(log.puts).map(row => row.id), ['m1', 'm2'], 'what the server returns is saved too');
  assert.equal(group.hasOlder, false);
  assert.equal(group.localHasMore, false);
});

test('load earlier keeps the reader in place and reports a network failure', async () => {
  const { sandbox, log } = load({ api:() => ({ error:'offline' }) });
  const group = { id:'g1', messages:[{ id:'m5', createdAt:50 }], hasOlder:true };
  sandbox.privateGroups.set('g1', group);
  await vm.runInContext("loadEarlierPrivateGroupMessages('g1')", sandbox);
  assert.equal(log.toasts.length, 1);
  assert.equal(group.messages.length, 1);
  assert.equal(group.loadingEarlier, false);
  assert.equal(group.hasOlder, true, 'a failed request does not claim there is nothing earlier');
});

test('wiring: leave/delete forget history, the list offers the button, dates and scroll are kept', () => {
  assert.match(groups, /function forgetPrivateGroupData\(groupId\) \{\s*if \(groupId\) historyStoreClearRoom\(privateGroupCacheCode\(groupId\)\);/);
  assert.match(groups, /onclick="loadEarlierPrivateGroupMessages\(\)">Load earlier messages/);
  assert.match(groups, /const separator = day !== previousDay \? daySeparatorHtml\(message\.createdAt\) : ''/);
  assert.match(groups, /keepDistanceFromBottom/);
  assert.match(extract('decodePrivateGroupBatch', 'async function'), /historyStoreDelete\(privateGroupCacheCode\(group\.id\), id\)/);
});
