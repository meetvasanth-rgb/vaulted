'use strict';

// "Delete for everyone" in a group hides the message on members' devices (an
// encrypted message in the stream) and also removes it from the server, so it
// can no longer be downloaded and decrypted by anyone holding the group key.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
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
const route = server.slice(server.indexOf("path === '/api/groups/delete-message'"), server.indexOf("path === '/api/groups/leave'"));

test('the route needs a session, checks membership through the store, limits and rate-limits requests', () => {
  assert.match(route, /authenticateAccountSession\(d\.accountId, d\.sessionToken\)/);
  assert.match(route, /groupStore\.deleteMessages\(d\.groupId, d\.accountId, ids\)/);
  assert.match(route, /\.slice\(0, 50\)/);
  assert.match(route, /rateLimited\(`group-delete-message:\$\{d\.accountId\}`/);
  assert.match(route, /Private group not found\./);
});

test('the stored attachment goes too: its object and its record', () => {
  assert.match(route, /groupStore\.attachment\(d\.groupId, attachmentId\)/);
  assert.match(route, /objectStorage\.delete\(attachment\.objectKey\)/);
  assert.match(route, /groupStore\.deleteAttachmentRecord\(attachmentId\)/);
});

test('the messages route reports a cursor that never goes backwards after a deletion', () => {
  assert.match(server, /Math\.max\(Number\(group\.lastMessageAt\) \|\| 0, group\.messages\[group\.messages\.length - 1\]\?\.createdAt \|\| 0\)/);
});

function load(apiImpl, { pending = [] } = {}) {
  const log = { api:[], saves:0 };
  const sandbox = vm.createContext({
    Set, Date, Object, Array, Number, Error, Math, Promise,
    loadAccountState:() => ({ accountId:'me', sessionToken:'t' }),
    savePrivateGroupSessions:() => { log.saves++; },
    api:async (url, body) => { log.api.push([url, JSON.parse(JSON.stringify(body))]); return apiImpl(url, body); },
  });
  vm.runInContext(groups.match(/const PRIVATE_GROUP_SERVER_DELETE_RETRY_MS = [^;]+;/)[0], sandbox);
  vm.runInContext(groups.match(/const PRIVATE_GROUP_SERVER_DELETE_MAX_FAILURES = \d+;/)[0], sandbox);
  vm.runInContext(extract(groups, 'flushPrivateGroupServerDeletes', 'async function'), sandbox);
  sandbox.group = { id:'g1', pendingServerDeletes:[...pending] };
  return { sandbox, log };
}
const plain = value => JSON.parse(JSON.stringify(value));

test('the app asks the server to drop what was deleted for everyone, then clears the queue', async () => {
  const { sandbox, log } = load(() => ({ ok:true, removed:['a', 'b'] }), { pending:['a', 'b'] });
  assert.equal(await vm.runInContext('flushPrivateGroupServerDeletes(group)', sandbox), true);
  assert.deepEqual(plain(log.api[0]), ['/api/groups/delete-message', { accountId:'me', sessionToken:'t', groupId:'g1', messageIds:['a', 'b'] }]);
  assert.deepEqual(plain(sandbox.group.pendingServerDeletes), []);
  assert.ok(log.saves >= 1, 'the cleared queue is saved');
});

test('an offline failure keeps the queue and waits before trying again', async () => {
  const { sandbox, log } = load(() => { throw new Error('offline'); }, { pending:['a'] });
  assert.equal(await vm.runInContext('flushPrivateGroupServerDeletes(group)', sandbox), false);
  assert.deepEqual(plain(sandbox.group.pendingServerDeletes), ['a']);
  assert.equal(sandbox.group.serverDeleteFailures, 1);
  assert.ok(sandbox.group.serverDeleteRetryAt > Date.now());
  assert.equal(log.saves, 0);
});

test('a server error is retried; a missing group or a refusal ends the queue', async () => {
  const busy = load(() => ({ error:'busy', status:503 }), { pending:['a'] });
  assert.equal(await vm.runInContext('flushPrivateGroupServerDeletes(group)', busy.sandbox), false);
  assert.deepEqual(plain(busy.sandbox.group.pendingServerDeletes), ['a']);
  for (const status of [404, 403, 400]) {
    const ended = load(() => ({ error:'no', status }), { pending:['a'] });
    assert.equal(await vm.runInContext('flushPrivateGroupServerDeletes(group)', ended.sandbox), true, String(status));
    assert.deepEqual(plain(ended.sandbox.group.pendingServerDeletes), []);
  }
});

test('an entry that keeps failing is eventually dropped', async () => {
  const { sandbox } = load(() => { throw new Error('offline'); }, { pending:['a'] });
  for (let i = 0; i < 10; i++) await vm.runInContext('flushPrivateGroupServerDeletes(group)', sandbox);
  assert.deepEqual(plain(sandbox.group.pendingServerDeletes), []);
});

test('only 50 are sent at a time, and a second flush cannot overlap the first', async () => {
  let release;
  const pending = Array.from({ length:70 }, (_, i) => `m${i}`);
  const { sandbox, log } = load(() => new Promise(resolve => { release = () => resolve({ ok:true }); }), { pending });
  const first = vm.runInContext('flushPrivateGroupServerDeletes(group)', sandbox);
  assert.equal(await vm.runInContext('flushPrivateGroupServerDeletes(group)', sandbox), false, 'already running');
  release(); await first;
  assert.equal(log.api.length, 1);
  assert.equal(log.api[0][1].messageIds.length, 50);
  assert.equal(sandbox.group.pendingServerDeletes.length, 20);
});

test('wiring: members are told first, the queue is saved with the group and retried from the poll', () => {
  const remove = extract(groups, 'deletePrivateGroupMessages', 'async function');
  assert.ok(remove.indexOf("type:'group-delete'") < remove.indexOf('flushPrivateGroupServerDeletes(group)'), 'control message before the server delete');
  assert.match(remove, /group\.pendingServerDeletes = \[\.\.\.new Set\(\[\.\.\.\(group\.pendingServerDeletes \|\| \[\]\), \.\.\.told\]\)\];\s*savePrivateGroupSessions\(\);/);
  assert.match(extract(groups, 'pollPrivateGroup', 'async function'), /group\.pendingServerDeletes\?\.length && Date\.now\(\) >= \(group\.serverDeleteRetryAt \|\| 0\)\) flushPrivateGroupServerDeletes\(group\)/);
  assert.match(client, /pendingServerDeletes:Array\.isArray\(group\.pendingServerDeletes\)/);
});
