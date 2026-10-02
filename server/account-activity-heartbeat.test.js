'use strict';

// account.lastActiveAt (what the admin dashboard's "last active" column and
// the free-number inactivity reclaim clock both read) used to move only at
// login and at the inbox socket's initial auth handshake — never again for
// the rest of that connection's life. Real message traffic runs entirely
// over room-token-authenticated HTTP routes (/api/join, /api/send,
// /api/poll), a separate auth path the account layer never sees. A healthy
// socket can then sit open for days of continuous real use without the
// account ever looking active again, since nothing re-stamps it. The
// server already pings every connected socket every 25s to keep it alive
// (see the setInterval near the bottom of index.js) — this reuses that
// existing heartbeat as the activity signal instead of adding new traffic.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { WebSocket } = require('ws');
const webpush = require('web-push');

test('the pong handler is wired to refresh account activity for an authenticated socket', () => {
  const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
  const start = server.indexOf("ws.on('pong', () => {");
  const end = server.indexOf("ws.on('error'", start);
  assert.notEqual(start, -1);
  const body = server.slice(start, end);
  assert.match(body, /if \(ws\.authenticated && ws\.accountId\) \{/);
  assert.match(body, /const account = accounts\.get\(ws\.accountId\);/);
  assert.match(body, /if \(account\) touchAccountActivity\(ws\.accountId, account\);/);
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(body),
  });
  return { status:response.status, data:await response.json() };
}

function nextMessage(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('timed out waiting for a message'));
    }, timeout);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw); } catch (e) { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

test('functional: pong advances lastActiveAt, and the admin list ranks genuine activity above a merely-newer registration', { timeout:15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-heartbeat-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const adminKey = 'test-admin-heartbeat-key';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, ADMIN_KEY:adminKey,
      VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey,
    },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const ws of sockets) ws.close();
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const alice = (await post(base, '/api/account/register', {
    accountId:'a'.repeat(64), privateNumber:'2345678901', displayName:'Alice',
    authSecret:'auth-a'.padEnd(48, 'a'), recoverySecret:'recovery-a'.padEnd(48, 'a'),
    passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
  })).data;

  async function lastActiveAt() {
    const response = await fetch(`${base}/api/admin/stats`, { headers:{ Authorization:'Bearer ' + adminKey } });
    assert.equal(response.status, 200);
    const stats = await response.json();
    const identity = stats.identities.find(entry => entry.privateNumber === '2345678901');
    assert.ok(identity, 'registered account is listed');
    return identity.lastActiveAt;
  }

  const afterRegister = await lastActiveAt();

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inbox`);
  sockets.push(ws);
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  const ready = nextMessage(ws, message => message.type === 'ready');
  ws.send(JSON.stringify({ type:'auth', accountId:alice.accountId, sessionToken:alice.sessionToken }));
  await ready;

  // Querying the admin endpoint itself never authenticates the account, so
  // this read alone cannot be what moves the timestamp — only the pong can.
  await new Promise(resolve => setTimeout(resolve, 80));
  const afterAuth = await lastActiveAt();
  assert.ok(afterAuth >= afterRegister, 'the auth handshake itself already touches it (existing behavior)');

  // Bob registers now, strictly after Alice's auth handshake — so at this
  // instant Bob's lastActiveAt (set at his own registration) is newer than
  // Alice's, and he'd rank above her. Only Alice's pong afterward, which the
  // old sort-by-updatedAt never reflected at all, should put her back ahead.
  await new Promise(resolve => setTimeout(resolve, 80));
  const bob = (await post(base, '/api/account/register', {
    accountId:'b'.repeat(64), privateNumber:'3456789012', displayName:'Bob',
    authSecret:'auth-b'.padEnd(48, 'b'), recoverySecret:'recovery-b'.padEnd(48, 'b'),
    passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
  })).data;
  assert.ok(bob);

  async function order() {
    const response = await fetch(`${base}/api/admin/stats`, { headers:{ Authorization:'Bearer ' + adminKey } });
    const stats = await response.json();
    const numbers = stats.identities.map(identity => identity.privateNumber);
    return { aliceIndex:numbers.indexOf('2345678901'), bobIndex:numbers.indexOf('3456789012') };
  }

  const beforePong = await order();
  assert.ok(beforePong.bobIndex < beforePong.aliceIndex, 'Bob (just registered) outranks Alice until she is active again');

  await new Promise(resolve => setTimeout(resolve, 80));
  // Sending an unsolicited pong exercises the exact server-side 'pong' event
  // the real 25s keepalive ping would eventually trigger, without the test
  // waiting 25 real seconds for it.
  ws.pong();
  await new Promise(resolve => setTimeout(resolve, 150));
  const afterPong = await lastActiveAt();
  assert.ok(afterPong > afterAuth, `pong should advance lastActiveAt further (${afterAuth} -> ${afterPong})`);

  const afterPongOrder = await order();
  assert.ok(afterPongOrder.aliceIndex !== -1 && afterPongOrder.bobIndex !== -1);
  assert.ok(afterPongOrder.aliceIndex < afterPongOrder.bobIndex, 'Alice (genuinely active via the heartbeat) now outranks Bob again');
});
