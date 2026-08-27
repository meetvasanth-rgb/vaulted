'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm, stat } = require('node:fs/promises');
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

async function startServer(port, snapshotDir, vapid) {
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SNAPSHOT_DIR: snapshotDir,
      ROOM_CHECKPOINT_INTERVAL_MS: '1000',
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
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
  return child;
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

test('periodic checkpoint restores active vaults after an ungraceful stop', { timeout: 15000 }, async t => {
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-durable-checkpoint-'));
  const vapid = webpush.generateVAPIDKeys();
  let child = null;
  t.after(async () => {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    await rm(snapshotDir, { recursive: true, force: true });
  });

  const firstPort = await freePort();
  child = await startServer(firstPort, snapshotDir, vapid);
  const firstBase = `http://127.0.0.1:${firstPort}`;
  const created = await post(firstBase, '/api/create', { name: 'Checkpoint test', persistent: true });
  assert.ok(created.code && created.token);
  const sent = await post(firstBase, '/api/send', {
    code: created.code,
    token: created.token,
    content: 'encrypted-test-ciphertext',
    msgId: 'checkpoint-message-1',
  });
  assert.equal(sent.ok, true);

  await new Promise(resolve => setTimeout(resolve, 1300));
  const checkpoint = join(snapshotDir, 'rooms-snapshot.json');
  assert.ok((await stat(checkpoint)).size > 0, 'periodic checkpoint should exist while server is running');

  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));

  const secondPort = await freePort();
  child = await startServer(secondPort, snapshotDir, vapid);
  const restored = await post(`http://127.0.0.1:${secondPort}`, '/api/poll', {
    code: created.code,
    token: created.token,
    lastSeq: 0,
    lastReceiptSeq: 0,
    lastReactionSeq: 0,
    lastDeletionSeq: 0,
    full: 1,
  });
  assert.equal(restored.roomGone, undefined);
  assert.ok(restored.messages.some(message => message.id === 'checkpoint-message-1'));
  assert.ok((await stat(checkpoint)).size > 0, 'checkpoint must remain durable after restore');
});
