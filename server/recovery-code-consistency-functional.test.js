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

test('lost recovery rotation responses cannot expose or sync a stale code', { timeout:15000 }, async t => {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), 'vaultlix-recovery-consistency-'));
  const vapid = webPush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), DATABASE_URL:'', REDIS_URL:'',
      SNAPSHOT_DIR:directory, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:'ignore',
  });
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(directory, { recursive:true, force:true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`${base}/api/account/private-number`, {
        method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}',
      });
      if (response.ok) { ready = await response.json(); break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready?.privateNumber && ready?.reservationToken);

  const post = async (path, body) => {
    const response = await fetch(base + path, {
      method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body),
    });
    return { status:response.status, data:await response.json() };
  };
  const firstSecret = 'A'.repeat(43);
  const replacementSecret = 'B'.repeat(43);
  const accountId = 'c'.repeat(64);
  const originalBundle = 'original-encrypted-bundle-value';
  const rotatedBundle = 'rotated-encrypted-bundle-value';
  const registered = await post('/api/account/register', {
    accountId, privateNumber:ready.privateNumber, reservationToken:ready.reservationToken,
    displayName:'Recovery Test', authSecret:'P'.repeat(43), recoverySecret:firstSecret,
    passwordWrap:'password-wrap-value-123456789', recoveryWrap:'recovery-wrap-value-123456789',
    bundle:originalBundle,
  });
  assert.equal(registered.status, 200);
  const auth = { accountId, sessionToken:registered.data.sessionToken };

  const missingProof = await post('/api/account/sync', {
    ...auth, revision:registered.data.revision, bundle:'unverified-bundle-value-12345',
  });
  assert.equal(missingProof.status, 409);
  assert.equal(missingProof.data.recoveryCodeMismatch, true);

  const staleProof = await post('/api/account/sync', {
    ...auth, revision:registered.data.revision, recoverySecret:replacementSecret,
    bundle:'stale-bundle-value-123456789',
  });
  assert.equal(staleProof.status, 409);
  assert.equal(staleProof.data.recoveryCodeMismatch, true);
  const unchanged = await post('/api/account/fetch', auth);
  assert.equal(unchanged.data.bundle, originalBundle);

  assert.deepEqual((await post('/api/account/recovery-code/check', { ...auth, recoverySecret:firstSecret })).data,
    { ok:true, matches:true });
  assert.deepEqual((await post('/api/account/recovery-code/check', { ...auth, recoverySecret:replacementSecret })).data,
    { ok:true, matches:false });

  // Treat this successful response as lost. The server has committed the new
  // verifier and bundle; a client journal must rediscover the pending code.
  const rotated = await post('/api/account/recovery-code', {
    ...auth, revision:registered.data.revision, recoverySecret:replacementSecret,
    recoveryWrap:'replacement-wrap-value-123456789', bundle:rotatedBundle,
  });
  assert.equal(rotated.status, 200);
  assert.deepEqual((await post('/api/account/recovery-code/check', { ...auth, recoverySecret:replacementSecret })).data,
    { ok:true, matches:true });
  assert.deepEqual((await post('/api/account/recovery-code/check', { ...auth, recoverySecret:firstSecret })).data,
    { ok:true, matches:false });

  const rejectedOldCode = await post('/api/account/sync', {
    ...auth, revision:rotated.data.revision, recoverySecret:firstSecret,
    bundle:'old-code-cannot-overwrite-12345',
  });
  assert.equal(rejectedOldCode.status, 409);
  assert.equal(rejectedOldCode.data.recoveryCodeMismatch, true);
  const preserved = await post('/api/account/fetch', auth);
  assert.equal(preserved.data.bundle, rotatedBundle);
});
