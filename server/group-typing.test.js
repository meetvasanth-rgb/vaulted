'use strict';

// Private groups show who is typing or recording a voice note: pictures, a small bubble (dots or a
// microphone) and a line naming them. The server relays a live-only sign of life to the other active
// members; clients hide it three seconds after the last one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const WebSocket = require('ws');
const webpush = require('web-push');

const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

// ── Client ──
function clientHarness({ activeGroup = 'g1', self = 'me' } = {}) {
  const holder = { hidden:true, innerHTML:'', attrs:{}, replaceChildren() { this.innerHTML = ''; }, setAttribute(name, value) { this.attrs[name] = value; } };
  const calls = [], timers = [];
  const group = { id:'g1', members:[
    { accountId:'me', displayName:'Me' },
    { accountId:'a', displayName:'Priya', profileImage:'data:image/jpeg;base64,AAAA' },
    { accountId:'b', displayName:'Dinesh' },
    { accountId:'c', displayName:'Madhan' },
    { accountId:'d', displayName:'<b>Eve</b>' },
  ] };
  const context = vm.createContext({
    document: { getElementById: id => id === 'group-typing' ? holder : null },
    privateGroups: new Map([['g1', group]]),
    activePrivateGroupId:activeGroup,
    loadAccountState: () => ({ accountId:self, sessionToken:'tok' }),
    displayProfileImageUri: value => typeof value === 'string' && value.startsWith('data:image/') ? value : null,
    escapeHtml: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`),
    api: (route, body) => { calls.push([route, body]); return Promise.resolve({}); },
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout: () => {},
    Map, Date, Array, Math, String,
  });
  const source = [
    'const GROUP_ACTIVITY_INTERVAL_MS = 2000; const GROUP_ACTIVITY_VISIBLE_MS = 3200;',
    'let groupActivitySentAt = { typing:0, recording:0 }; let groupActivityTimer = null; const groupActivityUntil = new Map();',
    extract(groups, 'groupMemberLabel'),
    ...['sendPrivateGroupActivity', 'handleGroupTypingEvent', 'clearPrivateGroupActivity', 'groupActivityLabel', 'renderPrivateGroupActivity'].map(name => extract(groups, name)),
  ].join('\n');
  vm.runInContext(source, context);
  return { context, holder, calls, timers };
}

const event = (accountId, activity = 'typing', groupId = 'g1') => ({ type:'group-typing', groupId, accountId, activity });

test('one person typing: their picture, dots and "Priya is typing…"', () => {
  const h = clientHarness();
  h.context.handleGroupTypingEvent(event('a'), 1000);
  assert.equal(h.holder.hidden, false);
  assert.match(h.holder.innerHTML, /<img src="data:image\/jpeg;base64,AAAA" alt=""\/>/);
  assert.match(h.holder.innerHTML, /<i class="t-dot"><\/i><i class="t-dot"><\/i><i class="t-dot"><\/i>/);
  assert.match(h.holder.innerHTML, /Priya is typing…/);
  assert.equal(h.holder.attrs['aria-label'], 'Priya is typing…');
});

test('several people: up to three pictures and a count for the rest', () => {
  const h = clientHarness();
  for (const id of ['a', 'b', 'c', 'd']) h.context.handleGroupTypingEvent(event(id), 1000);
  assert.equal((h.holder.innerHTML.match(/class="group-typing-avatar"/g) || []).length, 3);
  assert.match(h.holder.innerHTML, /Priya and 3 others are typing…/);
  const two = clientHarness();
  two.context.handleGroupTypingEvent(event('a'), 1000);
  two.context.handleGroupTypingEvent(event('b'), 1000);
  assert.match(two.holder.innerHTML, /Priya and Dinesh are typing…/);
  const three = clientHarness();
  for (const id of ['a', 'b', 'c']) three.context.handleGroupTypingEvent(event(id), 1000);
  assert.match(three.holder.innerHTML, /Priya and 2 others are typing…/);
});

test('someone recording a voice note gets a microphone bubble and their own line', () => {
  const h = clientHarness();
  h.context.handleGroupTypingEvent(event('b', 'recording'), 1000);
  assert.match(h.holder.innerHTML, /group-typing-recording/);
  assert.doesNotMatch(h.holder.innerHTML, /t-dot/);
  assert.match(h.holder.innerHTML, /Dinesh is recording a voice note…/);
  h.context.handleGroupTypingEvent(event('a', 'typing'), 1000);
  assert.match(h.holder.innerHTML, /t-dot/, 'mixed activity shows the ordinary typing bubble');
  assert.match(h.holder.innerHTML, /Dinesh and Priya are typing…|Priya and Dinesh are typing…/);
});

test('names and initials are escaped, and a member without a picture shows their initial', () => {
  const h = clientHarness();
  h.context.handleGroupTypingEvent(event('d'), 1000);
  assert.doesNotMatch(h.holder.innerHTML, /<b>Eve/);
  assert.match(h.holder.innerHTML, /&#60;b&#62;Eve&#60;\/b&#62; is typing…/);
  const plain = clientHarness();
  plain.context.handleGroupTypingEvent(event('b'), 1000);
  assert.match(plain.holder.innerHTML, /class="group-typing-avatar">D<\/span>/);
});

test('it lapses after three seconds, ends when a message arrives, and ignores your own and unknown groups', () => {
  const h = clientHarness();
  h.context.handleGroupTypingEvent(event('a'), 1000);
  h.context.renderPrivateGroupActivity(4100);
  assert.equal(h.holder.hidden, false, 'still showing at 3.1s');
  h.context.renderPrivateGroupActivity(4300);
  assert.equal(h.holder.hidden, true, 'gone after 3.2s');
  assert.equal(h.holder.innerHTML, '');

  const ended = clientHarness();
  ended.context.handleGroupTypingEvent(event('a'), 1000);
  ended.context.clearPrivateGroupActivity('g1');
  assert.equal(ended.holder.hidden, true);

  const own = clientHarness();
  own.context.handleGroupTypingEvent(event('me'), 1000);
  own.context.handleGroupTypingEvent(event('a', 'typing', 'unknown-group'), 1000);
  own.context.handleGroupTypingEvent({ type:'group-typing' }, 1000);
  assert.equal(own.holder.hidden, true);
});

test('only the open group shows it', () => {
  const closed = clientHarness({ activeGroup:null });
  closed.context.handleGroupTypingEvent(event('a'), 1000);
  assert.equal(closed.holder.hidden, true);
  const other = clientHarness({ activeGroup:'some-other' });
  other.context.handleGroupTypingEvent(event('a'), 1000);
  assert.equal(other.holder.hidden, true);
});

test('typing in the composer sends a sign of life at most every two seconds; recording has its own', () => {
  const h = clientHarness();
  assert.equal(h.context.sendPrivateGroupActivity('typing', 10_000), true);
  assert.equal(h.context.sendPrivateGroupActivity('typing', 11_000), false);
  assert.equal(h.context.sendPrivateGroupActivity('recording', 11_000), true, 'a separate clock');
  assert.equal(h.context.sendPrivateGroupActivity('typing', 12_000), true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls.map(([route, body]) => [route, body.groupId, body.activity]))), [
    ['/api/groups/typing', 'g1', 'typing'], ['/api/groups/typing', 'g1', 'recording'], ['/api/groups/typing', 'g1', 'typing'],
  ]);
  assert.equal(h.calls[0][1].sessionToken, 'tok');
  const none = clientHarness({ activeGroup:null });
  assert.equal(none.context.sendPrivateGroupActivity('typing', 10_000), false, 'nothing without an open group');
});

test('the page wiring: composer, recorder heartbeat, socket message, indicator slot and message-ends-typing', () => {
  assert.match(extract(groups, 'updatePrivateGroupComposer'), /if \(hasText\) sendPrivateGroupActivity\('typing'\);/);
  assert.match(groups, /privateGroupVoiceRecorder\.start\(\); document\.querySelector\('\.group-mic-btn'\)\?\.classList\.add\('recording'\);\s*[\s\S]*?sendPrivateGroupActivity\('recording'\);[\s\S]*?setInterval\(/);
  assert.match(extract(groups, 'closePrivateGroup'), /activePrivateGroupId = null;\s*renderPrivateGroupActivity\(\);/);
  assert.match(client, /<main class="group-chat-body" id="group-chat-body"><\/main>\s*<div class="group-typing" id="group-typing" role="status" aria-live="polite" hidden><\/div>/);
  assert.match(client, /if \(message\.type === 'group-typing'\) \{\s*if \(typeof handleGroupTypingEvent === 'function'\) handleGroupTypingEvent\(message\);\s*return;\s*\}/);
  assert.match(client, /if \(message\.kind === 'message' && typeof clearPrivateGroupActivity === 'function'\) clearPrivateGroupActivity\(message\.groupId\);/);
});

// ── Server ──
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const post = async (base, route, body) => {
  const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json().catch(() => ({})) };
};

test('the server relays typing and recording to the other active members only, live and unstored', { timeout:30000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'vaultlix-group-typing-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:path.join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) try { socket.terminate(); } catch (error) {}
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
  const carol = await register('c', '4567890123');
  const auth = account => ({ accountId:account.accountId, sessionToken:account.sessionToken });
  const room = (await post(base, '/api/create', { name:'Bob', pubKey:'bob-key', persistent:true })).data;
  await post(base, '/api/join', { name:'Alice', pubKey:'alice-key', code:room.code });
  const request = await post(base, '/api/connections/request', { ...auth(alice), privateNumber:'3456789012' });
  assert.equal((await post(base, '/api/connections/respond', { ...auth(bob), requestId:request.data.requestId, action:'accepted',
    inviteUrl:`https://vaultlix.com/join/${room.code}#k=AAAAAAAAAAAAAAAAAAAAAA` })).status, 200);
  const groupId = '86f315a3-4444-4444-8444-123456789def';
  assert.equal((await post(base, '/api/groups/create', { ...auth(bob), groupId, encryptedName:'n'.repeat(24), keyBinding:'k'.repeat(32),
    members:[{ roomCode:room.code, wrappedKey:'w'.repeat(24) }] })).status, 200);

  // Each member listens on their own inbox socket.
  async function listen(account) {
    const received = [];
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/inbox`);
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.on('open', () => socket.send(JSON.stringify({ type:'auth', ...auth(account) })));
      socket.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'ready') resolve();
        else received.push(message);
      });
      socket.on('error', reject);
      setTimeout(() => reject(new Error('inbox socket did not become ready')), 5000);
    });
    return received;
  }
  const bobSeen = await listen(bob);
  const aliceSeen = await listen(alice);
  const carolSeen = await listen(carol);
  const typing = () => bobSeen.filter(message => message.type === 'group-typing');
  const settle = () => new Promise(resolve => setTimeout(resolve, 400));

  assert.equal((await post(base, '/api/groups/typing', { ...auth(alice), groupId })).status, 200);
  await settle();
  assert.deepEqual(typing().map(({ type, groupId: id, accountId, activity }) => ({ type, id, accountId, activity })),
    [{ type:'group-typing', id:groupId, accountId:alice.accountId, activity:'typing' }]);
  assert.equal('sequence' in typing()[0], false, 'live-only: nothing to catch up on');

  await post(base, '/api/groups/typing', { ...auth(alice), groupId, activity:'recording' });
  await post(base, '/api/groups/typing', { ...auth(alice), groupId, activity:'<script>' });
  await settle();
  assert.deepEqual(typing().map(message => message.activity), ['typing', 'recording', 'typing'], 'anything but "recording" is typing');

  // The sender and people outside the group never receive it.
  assert.equal(aliceSeen.some(message => message.type === 'group-typing'), false);
  assert.equal(carolSeen.some(message => message.type === 'group-typing'), false);
  assert.equal((await post(base, '/api/groups/typing', { ...auth(carol), groupId })).status, 404, 'a non-member is refused');
  await settle();
  assert.equal(typing().length, 3, 'and nothing was relayed for them');
  assert.equal((await post(base, '/api/groups/typing', { accountId:alice.accountId, sessionToken:'wrong', groupId })).status, 401);
  assert.equal((await post(base, '/api/groups/typing', { ...auth(alice), groupId:'no-such-group' })).status, 404);

  // Bob typing reaches Alice.
  await post(base, '/api/groups/typing', { ...auth(bob), groupId });
  await settle();
  assert.equal(aliceSeen.filter(message => message.type === 'group-typing').length, 1);
});

test('the route is authenticated, rate limited, membership checked and never persists anything', () => {
  const route = server.slice(server.indexOf("path === '/api/groups/typing'"), server.indexOf("path === '/api/groups/edit-message'"));
  assert.match(route, /authenticateAccountSession\(d\.accountId, d\.sessionToken\)/);
  assert.match(route, /rateLimited\(`group-typing:\$\{d\.accountId\}`, 60, 60 \* 1000\)/);
  assert.match(route, /memberIds\.includes\(d\.accountId\)/);
  assert.match(route, /groupTypingBlocked\(memberId, d\.accountId\)/);
  assert.doesNotMatch(route, /groupStore\.(send|mutate)|persistAccount|writeFile/);
  // Removing a member drops the cached member list at once.
  assert.match(server, /if \(change === 'group-update' && payload\?\.groupId\) groupTypingMemberCache\.delete\(payload\.groupId\);/);
  assert.match(server, /if \(event\.type === 'group-typing' && event\.accountRouteId && event\.payload\)/);
});
