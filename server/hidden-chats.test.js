'use strict';

// Hidden chats: a 1:1 chat can be hidden behind a password. The real client
// code (password check, lockout, conceal/unlock, hide/unhide) is extracted and
// run here; the places that must honour it are pinned structurally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');

function extractFn(name) {
  let start = client.indexOf(`async function ${name}(`);
  if (start === -1) start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

// vm-realm objects are not reference-equal to main-realm literals.
const plain = value => JSON.parse(JSON.stringify(value));

function harness() {
  const storage = new Map();
  const calls = { refresh: 0, api: [], toasts: [], inbox: 0, saved: [], timers:new Map(), clearedTimers:[] };
  let nextTimerId = 0;
  const rooms = new Map([
    ['room-a', { code:'room-a', token:'tok-a', peerPrivateNumber:'2345678901' }],
    ['room-b', { code:'room-b', token:'tok-b', peerPrivateNumber:'3456789012' }],
    ['room-c', { code:'room-c', token:'tok-c', peerPrivateNumber:'4567890123' }],
  ]);
  const context = vm.createContext({
    Date, Set, Map, JSON, Math, Number, String, Array, Object, Uint8Array, TextEncoder, Promise, RegExp,
    crypto: webcrypto, atob, btoa,
    setTimeout: (fn, ms) => { const id = ++nextTimerId; calls.timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { calls.clearedTimers.push(id); calls.timers.delete(id); },
    localStorage: { getItem: k => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)), removeItem: k => storage.delete(k) },
    rooms, activeRoomCode:'room-a',
    normalizePrivateNumber: value => String(value || '').replace(/\D/g, ''),
    refreshHiddenChatsViewsCalls: calls,
    api: async (route, body) => { calls.api.push([route, body]); return { ok:true }; },
    toast: message => calls.toasts.push(message),
    openVaultInbox: () => { calls.inbox++; },
    closeConversationMenu: () => {},
    saveActiveRoomCode: code => calls.saved.push(code),
    document: { getElementById: id => id === 's-chat' ? { classList:{ contains:() => true } } : null },
    renderVaultList: () => { calls.refresh++; }, renderRoomTabs: () => {}, updateDocumentTitle: () => {},
    updateHiddenChatsSettingsStatus: () => {},
  });
  const code = [
    'bytesToBase64', 'base64UrlToBytes', 'bytesToBase64UrlCompact', 'deriveAppLockVerifier', 'equalBytes',
    'appLockDelayMs', 'appLockWaitCopy', 'normalizePrivateNumber',
  ].map(name => {
    try { return extractFn(name); } catch (error) { return ''; }
  }).join('\n');
  vm.runInContext(code, context);
  vm.runInContext('function normalizePrivateNumber(value) { return String(value || "").replace(/\\D/g, ""); }', context);
  const start = client.indexOf("const HIDDEN_CHATS_KEY = 'vaultlix_hidden_chats_v1';");
  const end = client.indexOf('function refreshHiddenChatsViews()');
  assert.ok(start !== -1 && end > start);
  vm.runInContext(client.slice(start, end).replace('let hiddenChatsDialog = null;', 'let hiddenChatsDialog = null;'), context);
  vm.runInContext(`function refreshHiddenChatsViews() { refreshHiddenChatsViewsCalls.refresh++; }
    const vaultSearchActive = false; function closeVaultSearch() {}
    function getActiveRoom() { return rooms.get(activeRoomCode); }
    ${extractFn('syncChatNotificationPrivacy')}
    ${extractFn('syncHiddenChatNotificationPrivacy')}
    ${extractFn('hideChat')}
    ${extractFn('unhideChat')}
    ${extractFn('lockHiddenChats')}
    function closeHiddenChatsDialog() {}`, context);
  return { context, storage, calls };
}

test('a hidden chat is concealed only while locked; other chats are never concealed', async () => {
  const { context } = harness();
  vm.runInContext("saveHiddenChatsStore({ codes:['room-b'] })", context);
  assert.equal(vm.runInContext("isChatConcealed('room-b')", context), true);
  assert.equal(vm.runInContext("isChatConcealed('room-a')", context), false);
  assert.equal(vm.runInContext("roomConcealed(rooms.get('room-b'))", context), true);
  assert.equal(vm.runInContext("roomConcealed(null)", context), false);
  vm.runInContext('hiddenChatsUnlocked = true', context);
  assert.equal(vm.runInContext("isChatConcealed('room-b')", context), false, 'visible once unlocked');
  assert.equal(vm.runInContext("isChatHidden('room-b')", context), true, 'still marked hidden');
});

test('the password is never stored; a correct one unlocks, a wrong one does not', async () => {
  const { context, storage } = harness();
  await vm.runInContext("setHiddenChatsPassword('open sesame')", context);
  const raw = storage.get('vaultlix_hidden_chats_v1');
  assert.ok(raw && !raw.includes('open sesame'));
  const store = JSON.parse(raw);
  assert.ok(store.salt && store.verifier && store.iterations === 310000);
  assert.equal(vm.runInContext('hiddenChatsPasswordSet()', context), true);
  const bad = await vm.runInContext("attemptHiddenChatsUnlock('wrong one')", context);
  assert.equal(bad.ok, false);
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), false);
  const good = await vm.runInContext("attemptHiddenChatsUnlock('open sesame')", context);
  assert.equal(good.ok, true);
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), true);
});

test('repeated wrong passwords lock further attempts out, even for the right password', async () => {
  const { context } = harness();
  await vm.runInContext("setHiddenChatsPassword('open sesame')", context);
  for (let i = 0; i < 5; i++) await vm.runInContext("checkHiddenChatsPassword('nope')", context);
  const blocked = await vm.runInContext("checkHiddenChatsPassword('open sesame')", context);
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Too many attempts/);
  assert.equal(blocked.locked, true);
});

test('hiding stores only this chat, re-locks, tells the server, and leaves the open chat', async () => {
  const { context, calls } = harness();
  await vm.runInContext("setHiddenChatsPassword('482913')", context);
  vm.runInContext("hideChat('room-a')", context);
  assert.deepEqual(plain(vm.runInContext('[...hiddenChatCodes()]', context)), ['room-a']);
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), false);
  assert.deepEqual(plain(calls.api), [['/api/notification-privacy', { code:'room-a', token:'tok-a', hidden:true }]]);
  assert.equal(calls.inbox, 1, 'the open chat is left for the inbox');
  assert.deepEqual(plain(calls.saved), [''], 'the remembered active chat is cleared');
  assert.equal(vm.runInContext('activeRoomCode', context), 'room-b', 'focus moves to a visible chat');
  assert.ok(calls.toasts.some(text => /Chat hidden/.test(text)));
});

test('a chat cannot be hidden until password setup has visibly completed', async () => {
  const { context, calls, storage } = harness();
  const salt = Buffer.alloc(16, 7).toString('base64url');
  storage.set('vaultlix_hidden_chats_v1', JSON.stringify({
    codes:[], salt, verifier:Buffer.alloc(32, 9).toString('base64url'),
    iterations:310000, numeric:true,
  }));
  assert.equal(vm.runInContext('hiddenChatsPasswordSet()', context), true, 'an incomplete older verifier exists');
  assert.equal(vm.runInContext('hiddenChatsSetupConfirmed()', context), false, 'the setup screen was not confirmed');
  assert.equal(vm.runInContext("hideChat('room-a')", context), false);
  assert.deepEqual(plain(vm.runInContext('[...hiddenChatCodes()]', context)), []);
  assert.equal(calls.api.length, 0);

  await vm.runInContext("setHiddenChatsPassword('482913')", context);
  assert.equal(vm.runInContext('hiddenChatsSetupConfirmed()', context), true);
  assert.equal(vm.runInContext("hideChat('room-a')", context), true);
  assert.deepEqual(plain(vm.runInContext('[...hiddenChatCodes()]', context)), ['room-a']);
});

test('unhiding removes only that chat and tells the server', async () => {
  const { context, calls } = harness();
  vm.runInContext("saveHiddenChatsStore({ codes:['room-a','room-b'] })", context);
  vm.runInContext("unhideChat('room-a')", context);
  assert.deepEqual(plain(vm.runInContext('[...hiddenChatCodes()]', context)), ['room-b']);
  assert.deepEqual(plain(calls.api), [['/api/notification-privacy', { code:'room-a', token:'tok-a', hidden:false }]]);
  vm.runInContext("unhideChat('room-c')", context);
  assert.equal(calls.api.length, 1, 'a chat that was never hidden is ignored');
});

test('on launch every hidden chat is re-announced to the server so notification wording stays private', async () => {
  const { context, calls } = harness();
  vm.runInContext("saveHiddenChatsStore({ codes:['room-b','room-c','gone-room'] })", context);
  vm.runInContext('syncHiddenChatNotificationPrivacy()', context);
  assert.deepEqual(calls.api.map(([, body]) => body.code).sort(), ['room-b', 'room-c']);
  assert.ok(calls.api.every(([route, body]) => route === '/api/notification-privacy' && body.hidden === true));
});

test('locking while a hidden chat is open returns to the inbox and conceals it again', async () => {
  const { context, calls } = harness();
  vm.runInContext("saveHiddenChatsStore({ codes:['room-a'] }); hiddenChatsUnlocked = true;", context);
  vm.runInContext('lockHiddenChats()', context);
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), false);
  assert.equal(calls.inbox, 1);
  vm.runInContext('lockHiddenChats()', context);
  assert.equal(calls.inbox, 1, 'locking when already locked does nothing');
});

test('a hidden contact\'s status is concealed while locked and shown once unlocked', async () => {
  const { context } = harness();
  vm.runInContext("saveHiddenChatsStore({ codes:['room-b'] })", context);
  assert.equal(vm.runInContext("statusAuthorConcealed('3456789012')", context), true);
  assert.equal(vm.runInContext("statusAuthorConcealed('+34 5678 9012'.replace(/\\D/g,''))", context), true);
  assert.equal(vm.runInContext("statusAuthorConcealed('2345678901')", context), false);
  vm.runInContext('hiddenChatsUnlocked = true', context);
  assert.equal(vm.runInContext("statusAuthorConcealed('3456789012')", context), false);
});

test('the hidden-chats list lives under its own storage key and is saved by patching, not overwriting', async () => {
  const { context, storage } = harness();
  await vm.runInContext("setHiddenChatsPassword('abcd')", context);
  vm.runInContext("saveHiddenChatsStore({ codes:['room-a'] })", context);
  const store = JSON.parse(storage.get('vaultlix_hidden_chats_v1'));
  assert.deepEqual(store.codes, ['room-a']);
  assert.ok(store.salt && store.verifier, 'saving the list kept the password verifier');
  assert.deepEqual([...storage.keys()].filter(key => /hidden/.test(key)), ['vaultlix_hidden_chats_v1']);
});

test('Chats has no persistent hidden-chat control; password management lives in Privacy & Security', () => {
  assert.doesNotMatch(client, /id="hidden-chats-toggle"/);
  assert.match(client, /id="settings-hidden-chats-row" onclick="openHiddenChatsSettings\(\)"/);
  assert.match(client, /id="hidden-chats-settings-status">Set up</);
  assert.doesNotMatch(client, /HIDDEN_CHATS_EYE_|toggleHiddenChatsFromInbox|updateHiddenChatsOpener/);
  assert.match(client, /type it into the normal Chats search and press Enter/);
});

test('pressing Enter on the private password in ordinary Chats search reveals hidden chats', async () => {
  let attempts = 0;
  let renders = 0;
  const context = vm.createContext({
    hiddenChatsUnlocked:false,
    hiddenChatsPasswordSet:() => true,
    hiddenChatCodes:() => new Set(['room-a']),
    loadHiddenChatsStore:() => ({ passwordLength:6 }),
    attemptHiddenChatsUnlock:async value => { attempts++; return { ok:value === '482913' }; },
    vaultSearchQuery:'482913',
    renderVaultList:() => { renders++; },
  });
  vm.runInContext(`${extractFn('unlockHiddenChatsFromSearchInput')}\n${extractFn('handleVaultSearchKeydown')}`, context);
  const event = { key:'Enter', currentTarget:{ value:'482913', dataset:{} }, prevented:false, preventDefault() { this.prevented = true; } };
  await context.handleVaultSearchKeydown(event);
  assert.equal(attempts, 1);
  assert.equal(event.prevented, true);
  assert.equal(event.currentTarget.value, '');
  assert.equal(context.vaultSearchQuery, '');
  assert.equal(renders, 1);
});

test('typing the full numeric password auto-unlocks on iOS without relying on Go', async () => {
  let attempts = 0;
  let renders = 0;
  const context = vm.createContext({
    hiddenChatsUnlocked:false,
    hiddenChatsPasswordSet:() => true,
    hiddenChatCodes:() => new Set(['room-a']),
    loadHiddenChatsStore:() => ({ passwordLength:6 }),
    attemptHiddenChatsUnlock:async value => { attempts++; return { ok:value === '000000' }; },
    vaultSearchQuery:'',
    renderVaultList:() => { renders++; },
  });
  vm.runInContext(`${extractFn('filterVaultList')}\n${extractFn('unlockHiddenChatsFromSearchInput')}\n${extractFn('handleVaultSearchInput')}`, context);
  const input = { value:'000000', dataset:{} };
  await context.handleVaultSearchInput(input);
  assert.equal(attempts, 1);
  assert.equal(input.value, '', 'the password is removed from the visible search field');
  assert.equal(context.vaultSearchQuery, '');
  assert.equal(renders, 2, 'the ordinary search renders, then the unlocked inbox renders');
});

test('000000 survives the real password verifier and unlocks through search input', async () => {
  const { context } = harness();
  await vm.runInContext("setHiddenChatsPassword('000000')", context);
  vm.runInContext("saveHiddenChatsStore({ codes:['room-b'] }); let vaultSearchQuery = '';", context);
  vm.runInContext(`${extractFn('filterVaultList')}\n${extractFn('unlockHiddenChatsFromSearchInput')}\n${extractFn('handleVaultSearchInput')}`, context);
  const input = { value:'000000', dataset:{} };
  context.searchInput = input;
  await vm.runInContext('handleVaultSearchInput(searchInput)', context);
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), true);
  assert.equal(input.value, '');
  assert.equal(vm.runInContext('vaultSearchQuery', context), '');
});

test('every place that lists or opens chats honours hidden chats', () => {
  const must = [
    [/const roomEntries = \[\.\.\.rooms\.values\(\)\]\.filter\(room => !roomConcealed\(room\)\)/, 'inbox rows and search'],
    [/for \(const room of rooms\.values\(\)\) \{\s*if \(roomConcealed\(room\)\) continue;\s*for \(const rec of uniqueVisibleConversationRecords/, 'calls tab'],
    [/!roomConcealed\(room\) && room\.historyLoaded/, 'load earlier calls'],
    [/if \(!isRoomVisible\(room\) && !roomConcealed\(room\)\) total \+= room\.unread/, 'unread badge and page title'],
    [/if \(!roomConcealed\(room\)\) messages \+= Math\.max/, 'Chats tab badge'],
    [/function notifyMsg\(room\) \{[^}]*if \(roomConcealed\(room\)\) return;/, 'no chime or banner'],
    [/const tabRooms = \[\.\.\.rooms\.values\(\)\]\.filter\(room => !roomConcealed\(room\)\)/, 'room tabs'],
    [/\[\.\.\.rooms\.values\(\)\]\.filter\(room => !roomConcealed\(room\)\)\.map\(room => \{\s*const label = escHtml/, 'emergency-erase list'],
    [/!roomConcealed\(room\) && \(options\.includeActiveRoom/, 'forward targets'],
    [/filter\(room => !roomConcealed\(room\) && room\.everOnline && room\.sharedKey && room\.peerPrivateNumber/, 'status audience'],
    [/if \(isChatConcealed\(code\)\) return; \/\/ a hidden chat only opens once unlocked/, 'setActiveRoom'],
    [/if \(isChatConcealed\(code\)\) \{ promptUnlockHiddenChats\(\(\) => openConversationAfterPaint\(code\)\); return false; \}/, 'opening a chat'],
    [/rooms\.has\(preferred\) && !isChatConcealed\(preferred\)\) \? preferred : firstVisibleRoomCode\(\)/, 'startup restore'],
    [/concealedNotifyCode/, 'notification tap asks for the password'],
  ];
  for (const [pattern, label] of must) assert.match(client, pattern, label);
  assert.equal((client.match(/!statusAuthorConcealed\(candidate\.authorPrivateNumber\)/g) || []).length, 2, 'status rail and status page');
  assert.match(groups, /filter\(room => !roomConcealed\(room\) && room\.sharedKey/, 'group creation picker');
  assert.match(groups, /groupAddCandidates\(group, \[\.\.\.rooms\.values\(\)\]\.filter\(room => !roomConcealed\(room\)\)/, 'group add-members picker');
});

test('hidden chats re-lock when the app goes to the background', () => {
  assert.match(client, /document\.addEventListener\('visibilitychange', \(\) => \{ if \(document\.hidden\) lockHiddenChats\(\); \}\);/);
  assert.match(client, /window\.addEventListener\('pagehide', lockHiddenChats\);/);
  assert.match(client, /let hiddenChatsUnlocked = false; \/\/ memory only/);
});

test('the chosen 15–60 second inactivity timeout survives inbox navigation and resets on activity', async () => {
  const { context, calls } = harness();
  await vm.runInContext("setHiddenChatsPassword('482913')", context);
  vm.runInContext("saveHiddenChatsStore({ codes:['room-a'], unlockSeconds:45 })", context);
  await vm.runInContext("attemptHiddenChatsUnlock('482913')", context);
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), true);
  assert.equal([...calls.timers.values()].at(-1).ms, 45000);
  const firstTimer = vm.runInContext('hiddenChatsRelockTimer', context);
  vm.runInContext('noteHiddenChatsActivity()', context);
  assert.ok(calls.clearedTimers.includes(firstTimer));
  assert.equal([...calls.timers.values()].at(-1).ms, 45000);
  const openInbox = extractFn('openVaultInbox');
  assert.doesNotMatch(openInbox, /hiddenChatsUnlocked\s*=\s*false/);
  const activeTimer = vm.runInContext('hiddenChatsRelockTimer', context);
  calls.timers.get(activeTimer).fn();
  assert.equal(vm.runInContext('hiddenChatsUnlocked', context), false);
});

test('the conversation menu offers Hide chat / Unhide chat and Settings manages its password', () => {
  assert.match(client, /onclick="hideChatFromConversationMenu\(\)"[\s\S]{0,400}id="conversation-menu-hide-label">Hide chat</);
  assert.match(client, /hideLabel\.textContent = isChatHidden\(activeRoomCode\) \? 'Unhide chat' : 'Hide chat'/);
  assert.match(client, /id="settings-hidden-chats-row" onclick="openHiddenChatsSettings\(\)"/);
  assert.match(client, /id="hidden-chats-overlay"/);
});

test('server: a hidden chat\'s pushes stop naming the other person', () => {
  assert.match(server, /if \(path==='\/api\/notification-privacy' && method==='POST'\) \{[\s\S]{0,200}!room\.members\.has\(d\.token\)\) return resErr\(res,'Not in conversation\.',403\)/);
  assert.match(server, /body: mb\.hidePreview \? 'New message' : `New message from \$\{m\.name\}`/);
  assert.match(server, /Incoming video call' : 'Incoming call'/);
  assert.match(server, /body: caller && caller\.name && !peerMember\.hidePreview \? `Missed call from/);
  assert.equal((server.match(/caller: peerMember\.hidePreview \? ''/g) || []).length, 2, 'missed-call data carries no caller name');
  assert.match(server, /'\/api\/notification-privacy',\s*\]\);/);
  assert.match(postgres, /hidePreview:member\.hidePreview === true \|\| undefined/);
  assert.match(postgres, /\.\.\.\(push\.hidePreview \? \{ hidePreview:true \} : \{\}\)/);
});

// Real server: the notification-privacy route accepts only a member's own token.
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const webpush = require('web-push');

test('server route: only a member of the conversation can set its notification privacy', { timeout:20000 }, async t => {
  const portProbe = createServer();
  await new Promise((resolve, reject) => portProbe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = portProbe.address().port;
  await new Promise(resolve => portProbe.close(resolve));
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'vaultlix-hidden-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
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
  const post = async (route, body) => {
    const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json' }, body:JSON.stringify(body) });
    return { status:response.status, data:await response.json().catch(() => ({})) };
  };
  const created = (await post('/api/create', { name:'Alice', pubKey:'alice-key', persistent:true })).data;
  const joined = (await post('/api/join', { name:'Bob', code:created.code, pubKey:'bob-key' })).data;
  assert.ok(created.code && created.token && joined.token);

  assert.equal((await post('/api/notification-privacy', { code:created.code, token:'not-a-member-token', hidden:true })).status, 403);
  assert.equal((await post('/api/notification-privacy', { code:'no-such-room', token:created.token, hidden:true })).status, 403);
  assert.equal((await post('/api/notification-privacy', { code:created.code, token:created.token, hidden:'yes' })).status, 400, 'hidden must be a boolean');
  const ok = await post('/api/notification-privacy', { code:created.code, token:created.token, hidden:true });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.data, { ok:true, hidden:true });
  const off = await post('/api/notification-privacy', { code:created.code, token:joined.token, hidden:false });
  assert.equal(off.status, 200);
  assert.deepEqual(off.data, { ok:true, hidden:false });
});

test('passwords are numbers only, 4 to 12 digits', () => {
  const { context } = harness();
  const problem = text => vm.runInContext(`hiddenChatsPasswordProblem(${JSON.stringify(text)})`, context);
  for (const good of ['1234', '0000', '123456', '123456789012']) assert.equal(problem(good), '', good);
  assert.match(problem('123'), /Use 4 to 12 digits/);
  assert.match(problem('1234567890123'), /Use 4 to 12 digits/);
  for (const bad of ['abcd', '12a4', '12 34', '12-34', '', '１２３４', '1.234', 'letmein']) assert.match(problem(bad), /digits only/, JSON.stringify(bad));
});

test('a numeric password is flagged numeric; a text one saved by the first release still unlocks but is not', async () => {
  const { context, storage } = harness();
  await vm.runInContext("setHiddenChatsPassword('482913')", context);
  assert.equal(JSON.parse(storage.get('vaultlix_hidden_chats_v1')).numeric, true);
  assert.equal(vm.runInContext('hiddenChatsPasswordIsNumeric()', context), true);
  assert.equal((await vm.runInContext("checkHiddenChatsPassword('482913')", context)).ok, true);

  const legacy = harness();
  await vm.runInContext("setHiddenChatsPassword('letmein')", legacy.context);
  assert.equal(vm.runInContext('hiddenChatsPasswordIsNumeric()', legacy.context), false);
  assert.equal((await vm.runInContext("checkHiddenChatsPassword('letmein')", legacy.context)).ok, true, 'old text password still works');
});

test('changing the password replaces the old one and keeps the hidden list', async () => {
  const { context } = harness();
  await vm.runInContext("setHiddenChatsPassword('111111')", context);
  vm.runInContext("saveHiddenChatsStore({ codes:['room-a'] })", context);
  await vm.runInContext("setHiddenChatsPassword('222222')", context);
  assert.equal((await vm.runInContext("checkHiddenChatsPassword('111111')", context)).ok, false);
  assert.equal((await vm.runInContext("checkHiddenChatsPassword('222222')", context)).ok, true);
  assert.deepEqual(plain(vm.runInContext('[...hiddenChatCodes()]', context)), ['room-a']);
});

test('the password fields use the numeric keypad and strip anything that is not a digit', () => {
  assert.match(client, /id="hidden-chats-new" type="password" inputmode="numeric" pattern="\[0-9\]\*" maxlength="12"/);
  assert.match(client, /id="hidden-chats-confirm" type="password" inputmode="numeric" pattern="\[0-9\]\*" maxlength="12"/);
  assert.match(client, /input\.setAttribute\('inputmode', digitsOnly \? 'numeric' : 'text'\)/);
  assert.match(client, /const digitsOnly = field !== 'current' \|\| hiddenChatsPasswordIsNumeric\(\);/);
  const start = client.indexOf("document.addEventListener('input', event => {\n  const input = event.target;\n  if (input?.dataset?.digitsOnly === '1')");
  assert.notEqual(start, -1);
  const block = client.slice(start, client.indexOf('});\n', start) + 4);
  let handler;
  const context = vm.createContext({ HIDDEN_CHATS_MAX_LENGTH: 12, document: { addEventListener: (type, fn) => { if (type === 'input') handler = fn; } } });
  vm.runInContext(block, context);
  const digits = { dataset:{ digitsOnly:'1' }, value:'12a-3 4b5678901234567' };
  handler({ target:digits });
  assert.equal(digits.value, '123456789012', 'letters, spaces and dashes removed, capped at 12');
  const text = { dataset:{ digitsOnly:'' }, value:'letmein' };
  handler({ target:text });
  assert.equal(text.value, 'letmein', 'a legacy text current-password field is left alone');
  const other = { dataset:{}, value:'ab c' };
  handler({ target:other });
  assert.equal(other.value, 'ab c', 'other inputs are untouched');
});

test('setup and change reject non-numeric passwords with a clear message, and the inbox bar offers Manage', () => {
  assert.match(client, /const problem = hiddenChatsPasswordProblem\(next\);\s*if \(problem\) \{ error\.textContent = problem; return; \}/);
  assert.match(client, /class="hidden-chats-bar">[\s\S]{0,300}onclick="openHiddenChatsDialog\('manage'\)">Manage<\/button>/);
  assert.match(client, /Choose a numeric password \(4 to 12 digits\)/);
});

test('manage offers a polished timeout control without Lock now', () => {
  assert.match(client, /const HIDDEN_CHATS_TIMEOUT_OPTIONS = \[15, 30, 45, 60\]/);
  assert.match(client, /id="hidden-chats-form"[^>]*locker-sheet hidden-chats-sheet|locker-sheet hidden-chats-sheet[^>]*id="hidden-chats-form"/);
  assert.match(client, /id="hidden-chats-timeout-options"/);
  assert.match(client, /hidden-chats-change/);
  assert.match(client, /hidden-chats-remove/);
  assert.doesNotMatch(client, /add\('Lock now'/);
  assert.doesNotMatch(client, /onclick="lockHiddenChats\(\)">Lock<\/button>/);
});

test('Settings → Privacy & Security contains hidden-chat password management', () => {
  const fn = extractFn('openSettingsCategory');
  const rows = fn.match(/const generalRows = \{([\s\S]*?)\n  \};/)?.[1] || '';
  assert.match(rows, /privacy:\['settings-app-lock-row','settings-hidden-chats-row','settings-locker-row'\]/);
  assert.match(client, /function updateHiddenChatsSettingsStatus\(\)[\s\S]{0,500}configured \? 'On' : 'Set up'/);
  assert.match(client, /updateAppLockStatus\(\);\s*updateHiddenChatsSettingsStatus\(\);\s*updateLockerStatus\(\);/);
});

test('every row in the general settings section is reachable from some category page', () => {
  const fn = extractFn('openSettingsCategory');
  const rows = fn.match(/const generalRows = \{([\s\S]*?)\n  \};/)?.[1] || '';
  const section = client.slice(client.indexOf('id="settings-general-section"'), client.indexOf('id="settings-share-section"'));
  const ids = [...section.matchAll(/class="settings-row" id="(settings-[a-z-]+-row)"/g)].map(match => match[1]);
  assert.ok(ids.includes('settings-app-lock-row'));
  const unreachable = ids.filter(id => !rows.includes(`'${id}'`));
  assert.deepEqual(unreachable.filter(id => id === 'settings-hidden-chats-row'), []);
});
