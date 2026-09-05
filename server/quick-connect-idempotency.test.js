'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
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
  const response = await fetch(base + pathname, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  return { status:response.status, data:await response.json() };
}

test('Quick Connect classifies both directions of an existing relationship without duplicates', { timeout:15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-quick-connect-test-'));
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
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); }
    });
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

  const first = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(first.data.status, 'pending');
  const repeated = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(repeated.data.status, 'pending');
  assert.equal(repeated.data.requestId, first.data.requestId);

  const crossed = await post(base, '/api/connections/request', { ...auth(bob), privateNumber:'2345678901' });
  assert.equal(crossed.data.status, 'action_required');
  assert.equal(crossed.data.requestId, first.data.requestId);

  const accepted = await post(base, '/api/connections/respond', {
    ...auth(bob), requestId:first.data.requestId, action:'accepted',
    inviteUrl:'https://vaultlix.com/join/quick-connect-test#k=AAAAAAAAAAAAAAAAAAAAAA',
  });
  assert.equal(accepted.data.status, 'accepted');

  const aliceAgain = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  const bobAgain = await post(base, '/api/connections/request', { ...auth(bob), privateNumber:'2345678901' });
  assert.equal(aliceAgain.data.status, 'connected');
  assert.equal(bobAgain.data.status, 'connected');
  assert.equal(aliceAgain.data.requestId, first.data.requestId);
  assert.equal(bobAgain.data.requestId, first.data.requestId);
});

test('accepted relationships survive request-expiry cleanup and the client opens a matching room', () => {
  const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
  const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
  assert.match(server, /function compactConnectionRequests\(requests, now = Date\.now\(\)\)/);
  assert.match(server, /acceptedPairs\.has\(connectionPairKey\(request\)\)/);
  assert.match(server, /status:'connected'/);
  assert.match(server, /status:needsResponse \? 'action_required' : 'pending'/);
  assert.match(client, /function roomForPrivateNumber\(privateNumber\)/);
  assert.match(client, /Opened your existing private conversation/);
  assert.match(client, /result\.status === 'action_required'/);
});
