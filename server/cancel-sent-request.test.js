'use strict';

// A sender can cancel a connection request that has not been answered. Both copies are
// removed, nothing is held against either side, and only the sender can do it.

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

const fs = require('node:fs');
const path = require('node:path');

test('the sender cancels a pending request: it vanishes for both sides and can be sent again at once', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const sent = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro() });
  assert.equal(sent.data.status, 'pending');
  const id = (await post(base, '/api/connections/list', auth(alice))).data.requests[0].id;
  assert.equal((await post(base, '/api/connections/list', auth(bob))).data.requests.length, 1);

  const cancelled = await post(base, '/api/connections/cancel', { ...auth(alice), requestId:id });
  assert.equal(cancelled.status, 200);
  assert.equal((await post(base, '/api/connections/list', auth(alice))).data.requests.length, 0);
  assert.equal((await post(base, '/api/connections/list', auth(bob))).data.requests.length, 0);

  // No cooldown: a new request goes straight through.
  const again = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('H'.repeat(30)) });
  assert.equal(again.data.status, 'pending');
  assert.equal((await post(base, '/api/connections/list', auth(bob))).data.requests.length, 1);
});

test('only the sender can cancel, and only while the request is pending', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  const id = (await post(base, '/api/connections/list', auth(alice))).data.requests[0].id;

  assert.equal((await post(base, '/api/connections/cancel', { ...auth(bob), requestId:id })).status, 404, 'the recipient cannot cancel');
  assert.equal((await post(base, '/api/connections/cancel', { accountId:alice.accountId, sessionToken:'nope', requestId:id })).status, 401);
  assert.equal((await post(base, '/api/connections/list', auth(bob))).data.requests.length, 1, 'still there');

  const accepted = await post(base, '/api/connections/respond', { ...auth(bob), requestId:id, action:'accepted', inviteUrl:'https://vaultlix.com/join/abc-def-1234' });
  assert.equal(accepted.status, 200);
  assert.equal((await post(base, '/api/connections/cancel', { ...auth(alice), requestId:id })).status, 404, 'an answered request cannot be cancelled');
});

test('the Requests page offers Cancel request on a sent request, behind a confirmation', () => {
  const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
  assert.match(client, /onclick="cancelSentRequest\('\$\{escapeHtml\(request\.id\)\}'\)">Cancel request<\/button>/);
  assert.match(client, /if \(!\(await confirmCancelSentRequest\(label\)\)\) return;/);
  assert.match(client, /api\('\/api\/connections\/cancel'/);
});
