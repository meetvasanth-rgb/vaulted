'use strict';

// Message requests, step 1: every account publishes a public inbox key, and a sender can
// attach up to three short messages — encrypted to that key, unreadable by the server —
// to a connection request that has not been answered yet.

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
  return { status:response.status, data:await response.json().catch(() => ({})) };
}

const key = (letter = 'A') => ({ x:letter.repeat(43), y:letter.repeat(43) });
const intro = (ct = 'C'.repeat(40)) => ({ epk:key('E'), iv:'B'.repeat(16), ct });

async function startServer(t) {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-intro-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 8000);
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
  return { base, alice, bob, auth };
}

test('an account publishes one inbox key; a different key needs replace:true', { timeout:20000 }, async t => {
  const { base, bob, auth } = await startServer(t);
  assert.equal((await post(base, '/api/account/inbox-key', { ...auth(bob) })).data.inboxKey, null, 'none yet');
  const first = await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('K') });
  assert.deepEqual(first.data, { ok:true, accepted:true, inboxKey:key('K') });
  assert.deepEqual((await post(base, '/api/account/inbox-key', { ...auth(bob) })).data.inboxKey, key('K'));
  const other = await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('M') });
  assert.deepEqual(other.data, { ok:true, accepted:false, inboxKey:key('K') }, 'the first key wins');
  const replaced = await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('M'), replace:true });
  assert.equal(replaced.data.accepted, true);
  assert.deepEqual(replaced.data.inboxKey, key('M'));
  assert.equal((await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:{ x:'short', y:'short' } })).status, 400);
  assert.equal((await post(base, '/api/account/inbox-key', { accountId:bob.accountId, sessionToken:'nope', publicKey:key('K') })).status, 401);
});

test('a sender can fetch a person\'s inbox key before writing, and only when it is allowed', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const before = await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' });
  assert.deepEqual(before.data, { ok:true, inboxKey:null, introMax:3 });
  await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('K') });
  const after = await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' });
  assert.deepEqual(after.data.inboxKey, key('K'));
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'2345678901' })).status, 400, 'not yourself');
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'9999999999' })).status, 404);
  assert.equal((await post(base, '/api/connections/prepare', { accountId:alice.accountId, sessionToken:'x', privateNumber:'3456789012' })).status, 401);
});

test('a request carries an encrypted message to the recipient only; the sender keeps just a count', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const sent = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('H'.repeat(30)) });
  assert.equal(sent.data.status, 'pending');
  assert.equal(sent.data.introCount, 1);
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal(bobList.length, 1);
  assert.equal(bobList[0].direction, 'incoming');
  assert.equal(bobList[0].intro.length, 1);
  assert.equal(bobList[0].intro[0].ct, 'H'.repeat(30));
  assert.deepEqual(bobList[0].intro[0].epk, key('E'));
  const aliceList = (await post(base, '/api/connections/list', auth(alice))).data.requests;
  assert.equal(aliceList[0].direction, 'outgoing');
  assert.equal('intro' in aliceList[0], false, 'ciphertext never goes back to the sender');
  assert.equal(aliceList[0].introCount, 1);
});

test('up to three messages while the request waits, then the sender must wait for a reply', { timeout:20000 }, async t => {
  const { base, alice, auth } = await startServer(t);
  const first = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro() });
  assert.equal(first.data.introCount, 1);
  const second = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('D'.repeat(30)) });
  assert.equal(second.data.status, 'pending');
  assert.equal(second.data.requestId, first.data.requestId, 'same request, not a new one');
  assert.equal(second.data.introCount, 2);
  assert.equal((await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('F'.repeat(30)) })).data.introCount, 3);
  const fourth = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('G'.repeat(30)) });
  assert.equal(fourth.status, 429);
  assert.match(fourth.data.error, /3 messages until they reply/);
  const repeatedWithoutMessage = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(repeatedWithoutMessage.data.status, 'pending', 'a plain repeat is still harmless');
});

test('the recipient cannot add messages to the request they were sent, and bad messages are refused', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro() });
  const crossed = await post(base, '/api/connections/request', { ...auth(bob), privateNumber:'2345678901', intro:intro('Z'.repeat(30)) });
  assert.equal(crossed.data.status, 'action_required');
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal(bobList[0].intro.length, 1, 'their message did not land in the request');

  const fresh = await startServer(t);
  const bad = [
    { ...intro(), epk:{ x:'bad', y:'bad' } },
    { ...intro(), iv:'short' },
    { ...intro(), ct:'x'.repeat(3201) },
    { ...intro(), ct:'has spaces and !!' },
    'not an object',
  ];
  for (const message of bad) {
    const result = await post(fresh.base, '/api/connections/request', { ...fresh.auth(fresh.alice), privateNumber:'3456789012', intro:message });
    assert.equal(result.status, 400, JSON.stringify(message).slice(0, 60));
  }
});

test('a request with no message still works exactly as before', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const sent = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(sent.data.status, 'pending');
  assert.equal(sent.data.introCount, 0);
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal('intro' in bobList[0], false);
});
