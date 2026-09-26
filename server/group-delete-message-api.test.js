'use strict';

// End to end, against a real server: a message deleted for everyone in a group
// is no longer returned to any member, only its sender can delete it, and
// message times stay unique and rising.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const webpush = require('web-push');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json() };
}

test('delete for everyone removes a group message from the server for every member', { timeout:20000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-group-delete-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', ADMIN_KEY:'test-admin-group-delete', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  async function register(letter, privateNumber) {
    const result = await post(base, '/api/account/register', {
      accountId:letter.repeat(64), privateNumber, displayName:`User ${letter}`,
      authSecret:`auth-${letter}`.padEnd(48, letter), recoverySecret:`recovery-${letter}`.padEnd(48, letter),
      passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
    });
    assert.equal(result.status, 200);
    return result.data;
  }
  const alice = await register('a', '2345678901');
  const bob = await register('b', '3456789012');
  const auth = account => ({ accountId:account.accountId, sessionToken:account.sessionToken });

  // Bob creates the group; Alice is in it through their accepted connection.
  const room = (await post(base, '/api/create', { name:'Bob', pubKey:'bob-key', persistent:true })).data;
  await post(base, '/api/join', { name:'Alice', pubKey:'alice-key', code:room.code });
  const request = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal((await post(base, '/api/connections/respond', { ...auth(bob), requestId:request.data.requestId, action:'accepted',
    inviteUrl:`https://vaultlix.com/join/${room.code}#k=AAAAAAAAAAAAAAAAAAAAAA` })).status, 200);
  const groupId = '86f315a3-3333-4333-8333-123456789def';
  const created = await post(base, '/api/groups/create', { ...auth(bob), groupId, encryptedName:'n'.repeat(24), keyBinding:'k'.repeat(32),
    members:[{ roomCode:room.code, wrappedKey:'w'.repeat(24) }] });
  assert.equal(created.status, 200);

  const send = (account, id) => post(base, '/api/groups/send', { ...auth(account), groupId, messageId:id, ciphertext:`g1:${id}`.padEnd(40, 'x') });
  const ids = { a1:'alice-message-000001', b1:'bob---message-000001', a2:'alice-message-000002', a3:'alice-message-000003' };
  for (const [account, id] of [[alice, ids.a1], [bob, ids.b1], [alice, ids.a2], [alice, ids.a3]]) assert.equal((await send(account, id)).status, 200);

  const poll = async (account, extra = {}) => (await post(base, '/api/groups/messages', { ...auth(account), groupId, after:0, ...extra })).data;
  const before = await poll(bob);
  assert.deepEqual(before.messages.map(message => message.id), Object.values(ids).sort((x, y) => before.messages.findIndex(m => m.id === x) - before.messages.findIndex(m => m.id === y)));
  const times = before.messages.map(message => message.createdAt);
  assert.equal(new Set(times).size, times.length, 'no two messages share a time');
  assert.deepEqual([...times].sort((x, y) => x - y), times, 'times only rise');

  // Alice deletes two of hers and tries to delete Bob's.
  const remove = (account, list) => post(base, '/api/groups/delete-message', { ...auth(account), groupId, messageIds:list });
  const denied = await remove(alice, [ids.b1]);
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.data.removed, [], "someone else's message is not removed");
  const removed = await remove(alice, [ids.a1, ids.a3, 'unknown-message-id']);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.data.removed.sort(), [ids.a1, ids.a3].sort());

  // Neither member is sent them any more, from the start or when paging back.
  for (const account of [alice, bob]) {
    const after = await poll(account);
    assert.deepEqual(after.messages.map(message => message.id), [ids.b1, ids.a2]);
    assert.equal(JSON.stringify(after).includes(ids.a1), false);
    const paged = await poll(account, { after:0, before:Date.now() + 10000, limit:50 });
    assert.deepEqual(paged.messages.map(message => message.id), [ids.b1, ids.a2]);
  }

  // A new message cannot reuse the time of one that was deleted.
  const newest = Math.max(...times);
  assert.equal((await send(bob, 'bob---message-000002')).status, 200);
  const latest = (await poll(bob, { after:newest - 1 })).messages;
  assert.ok(latest.every(message => message.createdAt > newest - 1));
  const fresh = latest.find(message => message.id === 'bob---message-000002');
  assert.ok(fresh.createdAt > newest, 'later than everything ever stored, even what was deleted');

  // Access control.
  assert.equal((await post(base, '/api/groups/delete-message', { accountId:alice.accountId, sessionToken:'wrong-token', groupId, messageIds:[ids.a2] })).status, 401);
  assert.equal((await remove(alice, [])).status, 400);
  assert.equal((await post(base, '/api/groups/delete-message', { ...auth(alice), groupId:'00000000-0000-4000-8000-000000000000', messageIds:[ids.a2] })).status, 404);
  const stranger = await register('c', '4567890123');
  assert.equal((await remove(stranger, [ids.a2])).status, 404, 'a non-member cannot even tell the group exists');
  assert.deepEqual((await poll(bob)).messages.map(message => message.id).includes(ids.a2), true);
});
