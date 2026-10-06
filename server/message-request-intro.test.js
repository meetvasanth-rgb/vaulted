'use strict';

// Message requests, step 1: every account publishes a public inbox key, and a sender can
// attach up to three short messages — encrypted to that key, unreadable by the server —
// to a connection request that has not been answered yet.

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

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json().catch(() => ({})) };
}

const key = (letter = 'A') => ({ x:letter.repeat(43), y:letter.repeat(43) });
const intro = (ct = 'C'.repeat(40)) => ({ epk:key('E'), iv:'B'.repeat(16), ct });

async function startServer(t) {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-intro-test-'));
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
    const timer = setTimeout(() => reject(new Error('test server did not start')), 8000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); } });
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
  return { base, alice, bob, auth };
}

test('an account publishes one inbox key; a different key needs replace:true', { timeout:20000 }, async t => {
  const { base, bob, auth } = await startServer(t);
  assert.equal((await post(base, '/api/account/inbox-key', { ...auth(bob) })).data.inboxKey, null, 'none yet');
  const first = await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('K') });
  assert.deepEqual(first.data, { ok:true, accepted:true, inboxKey:key('K') });
  assert.deepEqual((await post(base, '/api/account/inbox-key', { ...auth(bob) })).data.inboxKey, key('K'));
  const other = await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('M') });
  assert.deepEqual(other.data, { ok:true, accepted:false, inboxKey:key('K') }, 'the first key wins');
  const replaced = await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('M'), replace:true });
  assert.equal(replaced.data.accepted, true);
  assert.deepEqual(replaced.data.inboxKey, key('M'));
  assert.equal((await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:{ x:'short', y:'short' } })).status, 400);
  assert.equal((await post(base, '/api/account/inbox-key', { accountId:bob.accountId, sessionToken:'nope', publicKey:key('K') })).status, 401);
});

test('a sender can fetch a person\'s inbox key before writing, and only when it is allowed', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const before = await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' });
  assert.deepEqual(before.data, { ok:true, inboxKey:null, introMax:3 });
  await post(base, '/api/account/inbox-key', { ...auth(bob), publicKey:key('K') });
  const after = await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' });
  assert.deepEqual(after.data.inboxKey, key('K'));
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'2345678901' })).status, 400, 'not yourself');
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'9999999999' })).status, 404);
  assert.equal((await post(base, '/api/connections/prepare', { accountId:alice.accountId, sessionToken:'x', privateNumber:'3456789012' })).status, 401);
});

test('a request carries an encrypted message to the recipient only; the sender keeps just a count', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const sent = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('H'.repeat(30)) });
  assert.equal(sent.data.status, 'pending');
  assert.equal(sent.data.introCount, 1);
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal(bobList.length, 1);
  assert.equal(bobList[0].direction, 'incoming');
  assert.equal(bobList[0].intro.length, 1);
  assert.equal(bobList[0].intro[0].ct, 'H'.repeat(30));
  assert.deepEqual(bobList[0].intro[0].epk, key('E'));
  const aliceList = (await post(base, '/api/connections/list', auth(alice))).data.requests;
  assert.equal(aliceList[0].direction, 'outgoing');
  assert.equal('intro' in aliceList[0], false, 'ciphertext never goes back to the sender');
  assert.equal(aliceList[0].introCount, 1);
});

test('up to three messages while the request waits, then the sender must wait for a reply', { timeout:20000 }, async t => {
  const { base, alice, auth } = await startServer(t);
  const first = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro() });
  assert.equal(first.data.introCount, 1);
  const second = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('D'.repeat(30)) });
  assert.equal(second.data.status, 'pending');
  assert.equal(second.data.requestId, first.data.requestId, 'same request, not a new one');
  assert.equal(second.data.introCount, 2);
  assert.equal((await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('F'.repeat(30)) })).data.introCount, 3);
  const fourth = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('G'.repeat(30)) });
  assert.equal(fourth.status, 429);
  assert.match(fourth.data.error, /3 messages until they reply/);
  const repeatedWithoutMessage = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(repeatedWithoutMessage.data.status, 'pending', 'a plain repeat is still harmless');
});

test('the recipient cannot add messages to the request they were sent, and bad messages are refused', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro() });
  const crossed = await post(base, '/api/connections/request', { ...auth(bob), privateNumber:'2345678901', intro:intro('Z'.repeat(30)) });
  assert.equal(crossed.data.status, 'action_required');
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal(bobList[0].intro.length, 1, 'their message did not land in the request');

  const fresh = await startServer(t);
  const bad = [
    { ...intro(), epk:{ x:'bad', y:'bad' } },
    { ...intro(), iv:'short' },
    { ...intro(), ct:'x'.repeat(3201) },
    { ...intro(), ct:'has spaces and !!' },
    'not an object',
  ];
  for (const message of bad) {
    const result = await post(fresh.base, '/api/connections/request', { ...fresh.auth(fresh.alice), privateNumber:'3456789012', intro:message });
    assert.equal(result.status, 400, JSON.stringify(message).slice(0, 60));
  }
});

test('a request with no message still works exactly as before', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const sent = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(sent.data.status, 'pending');
  assert.equal(sent.data.introCount, 0);
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal('intro' in bobList[0], false);
});

// ── Phase 3: who may send requests, and the quiet cooldown after a decline ──────────

async function registerExtra(base, letter, privateNumber) {
  const result = await post(base, '/api/account/register', {
    accountId:letter.repeat(64), privateNumber, displayName:`User ${letter}`,
    authSecret:`auth-${letter}`.padEnd(48, letter), recoverySecret:`recovery-${letter}`.padEnd(48, letter),
    passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
  });
  assert.equal(result.status, 200);
  return result.data;
}

test('the privacy choice defaults to anyone, can be changed, and rejects anything else', { timeout:20000 }, async t => {
  const { base, bob, auth } = await startServer(t);
  assert.deepEqual((await post(base, '/api/account/request-policy', auth(bob))).data, { ok:true, policy:'anyone' });
  assert.equal((await post(base, '/api/account/request-policy', { ...auth(bob), policy:'qr' })).data.policy, 'qr');
  assert.equal((await post(base, '/api/account/request-policy', auth(bob))).data.policy, 'qr');
  assert.equal((await post(base, '/api/account/request-policy', { ...auth(bob), policy:'everyone' })).status, 400);
  assert.equal((await post(base, '/api/account/request-policy', { accountId:bob.accountId, sessionToken:'x', policy:'none' })).status, 401);
});

test('"no one for now" refuses new requests but not people you already chat with', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  await post(base, '/api/account/request-policy', { ...auth(bob), policy:'none' });
  const refused = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /not accepting new requests/);
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' })).status, 403, 'refused before a message is written');

  // An existing, accepted relationship is unaffected: first connect while open, then close the door.
  await post(base, '/api/account/request-policy', { ...auth(bob), policy:'anyone' });
  const first = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  const room = await post(base, '/api/create', { name:'User a', pubKey:'k', persistent:true });
  await post(base, '/api/connections/respond', { ...auth(bob), requestId:first.data.requestId, action:'accepted', inviteUrl:`https://vaultlix.com/join/${room.data.code}#k=AAAAAAAAAAAAAAAAAAAAAA` });
  await post(base, '/api/account/request-policy', { ...auth(bob), policy:'none' });
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' })).status, 200);
  const again = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(again.data.status, 'connected', 'the existing relationship is still recognised');
  const reopened = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', replaceExisting:true });
  assert.equal(reopened.status, 200, 'reopening a chat is not held back by the privacy choice');
  assert.equal(reopened.data.status, 'pending');
});

test('"QR or link only" needs the profile code, and a number lookup does not reveal it', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const code = bob.profileShareCode;
  assert.ok(code, 'the account has a profile code');
  await post(base, '/api/account/request-policy', { ...auth(bob), policy:'qr' });
  const lookup = await (await fetch(`${base}/api/profile/3456789012`)).json();
  assert.equal(lookup.profile.profileShareCode, null, 'not leaked through the number lookup');
  assert.equal(lookup.profile.address, null);
  const byLink = await (await fetch(`${base}/api/profile-share/${code}`)).json();
  assert.equal(byLink.profile.profileShareCode, code, 'the link itself still works');

  const noCode = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal(noCode.status, 403);
  assert.match(noCode.data.error, /QR code or profile link/);
  assert.equal((await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', shareCode:'ZZZZZZ' })).status, 403);
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012' })).status, 403);
  assert.equal((await post(base, '/api/connections/prepare', { ...auth(alice), privateNumber:'3456789012', shareCode:code })).status, 200);
  const withCode = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', shareCode:code });
  assert.equal(withCode.data.status, 'pending');

  await post(base, '/api/account/request-policy', { ...auth(bob), policy:'anyone' });
  const open = await (await fetch(`${base}/api/profile/3456789012`)).json();
  assert.equal(open.profile.profileShareCode, code, 'visible again when anyone may request');
});

test('after a decline the same sender is quietly held back for 15 days; others are not', { timeout:20000 }, async t => {
  const { base, alice, bob, auth } = await startServer(t);
  const carol = await registerExtra(base, 'c', '4567890123');
  const first = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro() });
  assert.equal(first.data.status, 'pending');
  const declined = await post(base, '/api/connections/respond', { ...auth(bob), requestId:first.data.requestId, action:'rejected' });
  assert.equal(declined.data.status, 'rejected');

  const retry = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012', intro:intro('R'.repeat(30)) });
  assert.equal(retry.status, 200, 'the sender is not told');
  assert.equal(retry.data.status, 'pending');
  assert.notEqual(retry.data.requestId, first.data.requestId);
  const bobList = (await post(base, '/api/connections/list', auth(bob))).data.requests;
  assert.equal(bobList.length, 0, 'nothing was delivered, and the decline marker is never sent to a client');
  assert.equal((await post(base, '/api/connections/list', auth(alice))).data.requests.filter(r => r.status === 'pending').length, 0, 'the sender has no live request either');

  const other = await post(base, '/api/connections/request', { ...auth(carol), privateNumber:'3456789012' });
  assert.equal(other.data.status, 'pending');
  assert.equal((await post(base, '/api/connections/list', auth(bob))).data.requests.length, 1, 'a different sender is delivered normally');
});

test('the cooldown ends after fifteen days', () => {
  const server = require('node:fs').readFileSync(join(__dirname, 'index.js'), 'utf8');
  assert.match(server, /const REQUEST_COOLDOWN_MS = 15 \* 24 \* 60 \* 60 \* 1000;/);
  const fn = server.slice(server.indexOf('function declinedRecently('), server.indexOf('function connectionPairKey('));
  const vm = require('node:vm');
  const ctx = vm.createContext({});
  vm.runInContext(server.slice(server.indexOf('const REQUEST_COOLDOWN_MS'), server.indexOf('function connectionPairKey(')) + '\nfunction normalizeProfileShareCode(v){return v}', ctx);
  const day = 24 * 60 * 60 * 1000;
  const now = 100 * day;
  ctx.account = { connectionRequests:[{ status:'rejected', direction:'incoming', senderAccountId:'a', respondedAt:now - 14 * day }] };
  assert.equal(vm.runInContext('declinedRecently(account, "a", ' + now + ')', ctx), true);
  assert.equal(vm.runInContext('declinedRecently(account, "b", ' + now + ')', ctx), false, 'another sender');
  ctx.account = { connectionRequests:[{ status:'rejected', direction:'incoming', senderAccountId:'a', respondedAt:now - 16 * day }] };
  assert.equal(vm.runInContext('declinedRecently(account, "a", ' + now + ')', ctx), false, 'after fifteen days');
  assert.match(fn, /request\.status === 'rejected' && request\.direction === 'incoming'/);
});
