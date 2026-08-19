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

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

test('passive polling does not keep a temporary vault alive', { timeout: 10000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-expiry-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SNAPSHOT_DIR: snapshotDir,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      TEST_ONE_TIME_ROOM_TTL_MS: '300',
      TEST_ROOM_EXPIRY_SWEEP_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const created = await post(base, '/api/create', { name: 'Expiry test' });
  assert.ok(created.code && created.token);

  let result = null;
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) {
    result = await post(base, '/api/poll', {
      code: created.code,
      token: created.token,
      lastSeq: 0,
      lastReceiptSeq: 0,
      lastReactionSeq: 0,
      lastDeletionSeq: 0,
    });
    if (result.roomGone) break;
    await new Promise(resolve => setTimeout(resolve, 40));
  }

  assert.equal(result.roomGone, true);
});
