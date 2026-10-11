const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const net = require('node:net');
const webPush = require('web-push');

async function freePort() {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startServer(directory, port, vapid) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), DATABASE_URL:'', REDIS_URL:'',
      SNAPSHOT_DIR:directory, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${base}/api/account/private-number`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}',
      });
      if (response.ok) return { child, base, reservation:await response.json() };
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  child.kill();
  throw new Error('test server did not start');
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise(resolve => child.once('exit', resolve));
}

test('an encrypted account bundle larger than 1 MB survives a server restart and recovery rotation', { timeout:20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'vaultlix-large-account-'));
  const vapid = webPush.generateVAPIDKeys();
  let running = null;
  t.after(async () => {
    if (running) await stopServer(running.child);
    await rm(directory, { recursive:true, force:true });
  });

  running = await startServer(directory, await freePort(), vapid);
  const post = async (path, body, authenticated = false) => {
    const response = await fetch(running.base + path, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', ...(authenticated ? {
        'X-Vaultlix-Account':body.accountId, 'X-Vaultlix-Session':body.sessionToken,
      } : {}) },
      body:JSON.stringify(body),
    });
    return { status:response.status, data:await response.json() };
  };
  const accountId = 'd'.repeat(64);
  const recoverySecret = 'R'.repeat(43);
  const registered = await post('/api/account/register', {
    accountId, privateNumber:running.reservation.privateNumber,
    reservationToken:running.reservation.reservationToken, displayName:'Large Backup',
    authSecret:'P'.repeat(43), recoverySecret,
    passwordWrap:'password-wrap-value-123456789', recoveryWrap:'recovery-wrap-value-123456789',
    bundle:'small-encrypted-bundle-value',
  });
  assert.equal(registered.status, 200);
  const auth = { accountId, sessionToken:registered.data.sessionToken };
  const largeBundle = 'E'.repeat(1400 * 1024);
  const synced = await post('/api/account/sync', {
    ...auth, revision:registered.data.revision, recoverySecret, bundle:largeBundle,
  }, true);
  assert.equal(synced.status, 200);

  const rotated = await post('/api/account/recovery-code', {
    ...auth, revision:synced.data.revision, recoverySecret,
    recoveryWrap:'replacement-wrap-value-123456789', bundle:largeBundle,
  }, true);
  assert.equal(rotated.status, 200);

  const privateNumber = running.reservation.privateNumber;
  await stopServer(running.child);
  running = await startServer(directory, await freePort(), vapid);
  const profile = await fetch(`${running.base}/api/profile/${privateNumber}`);
  assert.equal(profile.status, 200);
  assert.equal((await profile.json()).profile.privateNumber, privateNumber);
});
