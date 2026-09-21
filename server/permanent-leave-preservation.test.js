'use strict';

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

test('the last member leaving does not erase a permanent conversation', { timeout: 15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-permanent-leave-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: { ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir,
      VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
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

  const post = async (path, data) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(data),
    });
    return {status:response.status, data:response.status === 204 ? null : await response.json()};
  };

  const created = (await post('/api/create', { name:'Alice', pubKey:'alice-key', persistent:true })).data;
  const joined = (await post('/api/join', { code:created.code, name:'Bob', pubKey:'bob-key' })).data;
  assert.equal((await post('/api/send', {
    code:created.code, token:created.token, msgId:'preserved-1', content:'encrypted-ciphertext',
  })).status, 200);

  assert.equal((await post('/api/leave', {code:created.code, token:created.token})).status, 204);
  assert.equal((await post('/api/leave', {code:created.code, token:joined.token})).status, 204);

  const rejoined = await post('/api/join', {code:created.code, name:'Alice', pubKey:'alice-key'});
  assert.equal(rejoined.status, 200, 'a permanent conversation should remain joinable');
  const history = await post('/api/poll', {
    code:created.code, token:rejoined.data.token, lastSeq:0, full:1,
  });
  assert.equal(history.status, 200);
  assert.ok(history.data.messages.some(message => message.id === 'preserved-1'));
});
