'use strict';

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

function nextMessage(ws, predicate, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for session replacement')), timeout);
    function onMessage(raw) {
      let message;
      try { message = JSON.parse(raw); } catch (error) { return; }
      if (!predicate(message)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(message);
    }
    ws.on('message', onMessage);
  });
}

test('a sign-in on another device immediately replaces the previous session', { timeout:15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-single-device-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{
      ...process.env,
      NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir,
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
  const authSecret = 'account-auth-a'.padEnd(48, 'a');
  const registered = await post(base, '/api/account/register', {
    accountId:'a'.repeat(64), privateNumber:'2345678901', displayName:'Alice',
    authSecret, recoverySecret:'account-recovery-a'.padEnd(48, 'a'),
    passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
    deviceId:'first-device-installation-token',
  });
  assert.equal(registered.status, 200);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/inbox`);
  sockets.push(ws);
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  const ready = nextMessage(ws, message => message.type === 'ready');
  ws.send(JSON.stringify({
    type:'auth', accountId:registered.data.accountId, sessionToken:registered.data.sessionToken,
  }));
  await ready;

  const replacement = nextMessage(ws, message => message.type === 'account-update' && message.change === 'session-replaced');
  const signedIn = await post(base, '/api/account/login', {
    privateNumber:'2345678901', authSecret, deviceId:'second-device-installation-token',
  });
  assert.equal(signedIn.status, 200);
  assert.equal((await replacement).accountId, registered.data.accountId);

  const oldFetch = await post(base, '/api/account/fetch', {
    accountId:registered.data.accountId, sessionToken:registered.data.sessionToken,
  });
  assert.equal(oldFetch.status, 401);
  const newFetch = await post(base, '/api/account/fetch', {
    accountId:signedIn.data.accountId, sessionToken:signedIn.data.sessionToken,
  });
  assert.equal(newFetch.status, 200);

  const newAuthSecret = 'new-account-auth-b'.padEnd(48, 'b');
  const changed = await post(base, '/api/account/change-password', {
    accountId:signedIn.data.accountId,
    sessionToken:signedIn.data.sessionToken,
    currentAuthSecret:authSecret,
    newAuthSecret,
    passwordWrap:'n'.repeat(24),
    deviceId:'second-device-installation-token',
  });
  assert.equal(changed.status, 200);
  assert.equal((await post(base, '/api/account/fetch', {
    accountId:signedIn.data.accountId, sessionToken:signedIn.data.sessionToken,
  })).status, 401);
  assert.equal((await post(base, '/api/account/fetch', {
    accountId:changed.data.accountId, sessionToken:changed.data.sessionToken,
  })).status, 200);
  assert.equal((await post(base, '/api/account/login', {
    privateNumber:'2345678901', authSecret, deviceId:'third-device-installation-token',
  })).status, 403);
  assert.equal((await post(base, '/api/account/login', {
    privateNumber:'2345678901', authSecret:newAuthSecret, deviceId:'third-device-installation-token',
  })).status, 200);
});

test('session replacement is carried through native and web notification paths', () => {
  const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
  const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
  const worker = readFileSync(join(__dirname, '..', 'client', 'sw.js'), 'utf8');
  assert.match(server, /sessionReplaced:true/);
  assert.match(server, /clearAccountRoomPushDestinations/);
  assert.match(client, /clearReplacedAccountLocally/);
  assert.match(client, /deviceId:accountDeviceId\(\)/);
  assert.match(client, /id="account-change-password-form"/);
  assert.match(server, /\/api\/account\/change-password/);
  assert.match(worker, /type:'session-replaced'/);
});
