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
async function post(base, path, body) {
  const response = await fetch(base + path, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json() };
}

test('message edits are sender-only encrypted events and do not count as new messages', { timeout:15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-edit-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir,
      VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore','pipe','pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const creator = (await post(base, '/api/create', { name:'Creator' })).data;
  const peer = (await post(base, '/api/join', { code:creator.code, name:'Peer' })).data;
  const msgId = 'original_message_000001';
  const editId = 'edited_message_0000001';
  assert.equal((await post(base, '/api/send', { code:creator.code, token:creator.token, msgId, content:'v:encrypted-original-value' })).status, 200);
  const edit = await post(base, '/api/edit-message', { code:creator.code, token:creator.token, msgId, editId, content:'v:encrypted-edited-value' });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.ok, true);

  const poll = (await post(base, '/api/poll', { code:creator.code, token:peer.token, lastSeq:0, full:1 })).data;
  assert.deepEqual(poll.messages.map(message => [message.id, message.type, message.editOf || null]), [
    [msgId, 'message', null], [editId, 'edit', msgId],
  ]);
  assert.equal(poll.totalMessageCount, 1, 'an edit is not a new message');
  assert.equal(poll.messages.find(message => message.id === editId).content, 'v:encrypted-edited-value');

  const denied = await post(base, '/api/edit-message', { code:creator.code, token:peer.token, msgId, editId:'peer_edit_0000000001', content:'v:encrypted-hostile-edit' });
  assert.equal(denied.status, 403);
  const duplicate = await post(base, '/api/edit-message', { code:creator.code, token:creator.token, msgId, editId, content:'v:encrypted-edited-value' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.data.duplicate, true);
});
