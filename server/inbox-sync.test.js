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

test('client uses one inbox channel instead of per-conversation polling timers', () => {
  const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
  assert.match(client, /new WebSocket\(`\$\{proto\}\/\/\$\{location\.host\}\/ws\/inbox`\)/);
  assert.match(client, /api\('\/api\/inbox\/sync'/);
  assert.match(client, /room\.pollInterval = null;/);
  assert.match(client, /room\.typingInterval = null;/);
  assert.doesNotMatch(client, /room\.pollInterval = setInterval\(\(\) => doPoll\(room\), 2000\)/);
  assert.doesNotMatch(client, /room\.typingInterval = setInterval\(\(\) => checkTyping\(room\), 2500\)/);
});

test('room events use a direct subscription index instead of scanning every account socket', () => {
  const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
  assert.match(server, /const inboxSocketsByRoom = new Map\(\)/);
  assert.match(server, /const sockets = inboxSocketsByRoom\.get\(roomCode\)/);
  assert.match(server, /replaceInboxSubscriptions\(ws, subscriptions\)/);
  const publishBody = server.match(/function publishInboxRoom[\s\S]*?\n}\n\nfunction publishInboxAccount/)?.[0] || '';
  assert.doesNotMatch(publishBody, /inboxAccountSockets\.values|for \(const \[accountId, sockets\] of inboxAccountSockets\)/);
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
      reject(new Error('timed out waiting for inbox event'));
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

async function openInbox(url, account, conversation) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
  const ready = nextMessage(ws, message => message.type === 'ready');
  ws.send(JSON.stringify({ type:'auth', accountId:account.accountId, sessionToken:account.sessionToken }));
  await ready;
  const subscribed = nextMessage(ws, message => message.type === 'subscribed');
  ws.send(JSON.stringify({ type:'subscribe', conversations:[conversation] }));
  assert.equal((await subscribed).count, 1);
  return ws;
}

test('one authenticated inbox socket synchronizes all subscribed conversations', { timeout:15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-inbox-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: {
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
  async function register(suffix, privateNumber) {
    const result = await post(base, '/api/account/register', {
      accountId:suffix.repeat(64), privateNumber, displayName:`User ${suffix}`,
      authSecret:`auth-${suffix}`.padEnd(48, suffix), recoverySecret:`recovery-${suffix}`.padEnd(48, suffix),
      passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
    });
    assert.equal(result.status, 200);
    return result.data;
  }
  const alice = await register('a', '2345678901');
  const bob = await register('b', '3456789012');
  const created = (await post(base, '/api/create', { name:'Alice', pubKey:'alice-key', persistent:true })).data;
  const joined = (await post(base, '/api/join', { name:'Bob', code:created.code, pubKey:'bob-key' })).data;

  const aliceWs = await openInbox(`ws://127.0.0.1:${port}/ws/inbox`, alice, { code:created.code, token:created.token });
  sockets.push(aliceWs);
  const bobWs = await openInbox(`ws://127.0.0.1:${port}/ws/inbox`, bob, { code:created.code, token:joined.token });
  sockets.push(bobWs);

  const messageEvent = nextMessage(bobWs, message => message.type === 'room-update' && message.change === 'message');
  const sent = await post(base, '/api/send', { code:created.code, token:created.token, content:'opaque-ciphertext', msgId:'inbox-message-1' });
  assert.equal(sent.status, 200);
  assert.equal((await messageEvent).roomCode, created.code);

  const typingEvent = nextMessage(bobWs, message => message.type === 'typing');
  await post(base, '/api/typing', { code:created.code, token:created.token });
  assert.equal((await typingEvent).active, true);

  const catchup = await post(base, '/api/inbox/sync', {
    accountId:bob.accountId,
    sessionToken:bob.sessionToken,
    conversations:[{ code:created.code, token:joined.token, lastSeq:0 }],
  });
  assert.equal(catchup.status, 200);
  assert.equal(catchup.data.updates[0].changed, true);
});
