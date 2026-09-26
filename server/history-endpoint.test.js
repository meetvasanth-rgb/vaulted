'use strict';

// POST /api/history pages back through a conversation's older messages. The
// page builder and the SQL are tested directly; the endpoint's access rules run
// against a real server process (which has no PostgreSQL, so pages are empty).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const webpush = require('web-push');
const { buildHistoryPage } = require('./history-page');
const { PostgresStore } = require('./postgres');

const identity = value => value;
const sameToken = (left, right) => left === right;
const members = () => new Map([['tok-me', { name:'Me' }], ['tok-peer', { name:'Sam' }]]);
const durable = (seq, extra = {}) => ({ id:`m${seq}`, senderTokenHash:'tok-peer', seq, content:`v:${seq}`, ts:seq * 1000, ...extra });
const build = (rows, limit = 3) => buildHistoryPage({ room:{ members:members() }, token:'tok-me', rows, limit, sameToken, reactionsForViewer:identity });

test('a page is returned oldest first, shaped like poll messages', () => {
  const { messages, hasMore } = build([durable(4), durable(5), durable(6)]);
  assert.equal(hasMore, false);
  assert.deepEqual(messages.map(message => message.seq), [4, 5, 6]);
  assert.deepEqual(Object.keys(messages[0]).sort(),
    ['content', 'deleteTimerSeconds', 'deliveredAt', 'expiresAt', 'from', 'id', 'name', 'reactions', 'readAt', 'seq', 'ts', 'type', 'viewOnce']);
  assert.equal(messages[0].type, 'message');
  assert.equal(messages[0].name, 'Sam');
});

test('getting the extra row means there is more, and that row is not part of the page', () => {
  const { messages, hasMore } = build([durable(3), durable(4), durable(5), durable(6)], 3);
  assert.equal(hasMore, true);
  assert.deepEqual(messages.map(message => message.seq), [4, 5, 6], 'the oldest (extra) row is dropped');
});

test('your own messages are attributed to your token, others to their member key', () => {
  const { messages } = build([durable(1, { senderTokenHash:'tok-me' }), durable(2)]);
  assert.equal(messages[0].from, 'tok-me');
  assert.equal(messages[1].from, 'tok-peer');
});

test('a sender who is no longer in the conversation is left out', () => {
  const { messages } = build([durable(1, { senderTokenHash:'tok-gone' }), durable(2)]);
  assert.deepEqual(messages.map(message => message.seq), [2]);
});

test('receipts and reactions ride along, and nothing meant to vanish can appear', () => {
  const { messages } = buildHistoryPage({ room:{ members:members() }, token:'tok-me', limit:5, sameToken,
    rows:[durable(1, { deliveredAt:10, readAt:20, reactions:{ 'tok-peer':'enc' } })],
    reactionsForViewer: reactions => ({ mapped:reactions }) });
  assert.equal(messages[0].deliveredAt, 10);
  assert.equal(messages[0].readAt, 20);
  assert.deepEqual(messages[0].reactions, { mapped:{ 'tok-peer':'enc' } });
  assert.equal(messages[0].viewOnce, false);
  assert.equal(messages[0].deleteTimerSeconds, 0);
  assert.equal(messages[0].expiresAt, null);
});

test('junk rows produce an empty page', () => {
  assert.deepEqual(build(undefined), { messages:[], hasMore:false });
  assert.deepEqual(build([]), { messages:[], hasMore:false });
});

test('the SQL pages by sequence, skips anything meant to vanish, and asks for one extra row', async () => {
  const calls = [];
  const pool = { query:async (...args) => { calls.push(args); return { rows:[] }; } };
  const store = new PostgresStore('', { pool });
  await store.loadEncryptedHistoryPage('room-1', 40, 51, 999);
  const [sql, params] = calls[0];
  assert.match(sql, /sequence < \$2/);
  assert.match(sql, /view_once IS NOT TRUE/);
  assert.match(sql, /COALESCE\(delete_timer_seconds, 0\) = 0/);
  assert.match(sql, /expires_at IS NULL OR expires_at > \$3/);
  assert.match(sql, /ORDER BY sequence DESC[\s\S]*LIMIT \$4[\s\S]*ORDER BY sequence ASC/);
  assert.deepEqual(params, ['room-1', 40, 999, 51]);
});

test('the page size is capped and a bad cursor returns nothing', async () => {
  const calls = [];
  const pool = { query:async (...args) => { calls.push(args); return { rows:[] }; } };
  const store = new PostgresStore('', { pool });
  await store.loadEncryptedHistoryPage('room-1', 40, 5000, 1);
  assert.equal(calls[0][1][3], 101);
  calls.length = 0;
  for (const bad of [0, -1, 1.5, 'x', undefined, NaN]) assert.deepEqual(await store.loadEncryptedHistoryPage('room-1', bad, 10, 1), []);
  assert.equal(calls.length, 0, 'no query for a bad cursor');
});

test('recent-history loading is unchanged by sharing its enrichment', async () => {
  const pool = { query:async () => ({ rows:[{ conversation_id:'r', message_id:'m', sender_token_hash:'h', sequence:'2', ciphertext:'c', created_at:'5', expires_at:null, view_once:false }] }) };
  const [message] = await new PostgresStore('', { pool }).loadEncryptedMessages('r', 100, 1);
  assert.equal(message.seq, 2);
  assert.equal(message.content, 'c');
});

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
const post = async (base, pathname, body) => {
  const response = await fetch(base + pathname, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json() };
};

test('the endpoint checks membership, validates the cursor and rate-limits', { timeout:20000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-history-test-'));
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
    const timer = setTimeout(() => reject(new Error('test server did not start')), 6000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const room = await post(base, '/api/create', { name:'History test' });
  assert.ok(room.data.code && room.data.token);

  assert.deepEqual((await post(base, '/api/history', { code:'no-such-room', token:'x', beforeSeq:10 })).data, { roomGone:true });
  const denied = await post(base, '/api/history', { code:room.data.code, token:'not-a-member', beforeSeq:10 });
  assert.equal(denied.status, 403);
  // a member without PostgreSQL, or with a bad cursor, gets an empty page rather than an error
  for (const beforeSeq of [10, 0, 1, -5, 'x', undefined]) {
    const page = await post(base, '/api/history', { code:room.data.code, token:room.data.token, beforeSeq });
    assert.equal(page.status, 200);
    assert.deepEqual(page.data, { messages:[], hasMore:false });
  }
  let limited = null;
  for (let i = 0; i < 70 && !limited; i++) {
    const page = await post(base, '/api/history', { code:room.data.code, token:room.data.token, beforeSeq:10 });
    if (page.status === 429) limited = page;
  }
  assert.ok(limited, 'repeated history requests are rate-limited');
});

test('the route is wired to the page builder and never marks anything delivered or read', () => {
  const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
  const route = server.slice(server.indexOf("path==='/api/history'"), server.indexOf("// POST /api/mark-delivered"));
  assert.match(route, /room\.members\.has\(d\.token\)/);
  assert.match(route, /loadEncryptedHistoryPage\(d\.code, beforeSeq, limit \+ 1/);
  assert.match(route, /buildHistoryPage\(/);
  assert.doesNotMatch(route, /markMessagesDelivered|deliveredAt\s*=|readReported|readAt\s*=/);
});
