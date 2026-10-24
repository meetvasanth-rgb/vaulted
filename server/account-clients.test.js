'use strict';

// The admin page shows whether an identity was created through the web or the native app, and which
// kinds of client it has used since. It is detected from the User-Agent (the native shells append a
// Vaultlix marker) and stored as coarse kinds only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const webpush = require('web-push');
const { detectClientKind, normalizeClientKind, normalizeClientsSeen, noteAccountClient, describeAccountClients } = require('./account-clients');
const { PostgresStore } = require('./postgres');

const IOS_APP = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 VaultlixImageSafety/1';
const ANDROID_APP = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36 VaultlixImageSafety/1';
const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';

test('the native shells are told apart from the same phones using the website', () => {
  assert.equal(detectClientKind(IOS_APP), 'ios');
  assert.equal(detectClientKind(ANDROID_APP), 'android');
  assert.equal(detectClientKind('Mozilla/5.0 VaultlixNative/1 (Linux; Android 13)'), 'android');
  assert.equal(detectClientKind(IOS_SAFARI), 'web', 'Safari on an iPhone is the web, not the app');
  assert.equal(detectClientKind(ANDROID_CHROME), 'web');
  assert.equal(detectClientKind('Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130'), 'web');
  assert.equal(detectClientKind(''), 'web');
  assert.equal(detectClientKind(undefined), 'web');
  assert.equal(detectClientKind('VaultlixNative/1 on something unknown'), 'web');
});

test('only the three coarse kinds are ever stored, in a stable order', () => {
  assert.equal(normalizeClientKind('ios'), 'ios');
  assert.equal(normalizeClientKind('Mozilla/5.0 evil'), null);
  assert.equal(normalizeClientKind(undefined), null);
  assert.deepEqual(normalizeClientsSeen(['web', 'ios', 'ios', 'toaster', null]), ['ios', 'web']);
  assert.deepEqual(normalizeClientsSeen('ios'), []);
});

test('noting a client reports a change only the first time', () => {
  const account = {};
  assert.equal(noteAccountClient(account, 'web'), true);
  assert.equal(noteAccountClient(account, 'web'), false);
  assert.equal(noteAccountClient(account, 'ios'), true);
  assert.deepEqual(account.clientsSeen, ['ios', 'web']);
  assert.equal(noteAccountClient(account, 'nonsense'), false);
  assert.equal(noteAccountClient(null, 'web'), false);
});

test('the admin description falls back on notification destinations for older identities', () => {
  assert.deepEqual(describeAccountClients({}), { registeredVia: null, clientsSeen: [], usesApp: false });
  assert.deepEqual(
    describeAccountClients({ pushDestinations:[{ platform:'android' }, { platform:'webpush' }] }),
    { registeredVia: null, clientsSeen: ['android'], usesApp: true },
    'an Android notification destination proves the app was used');
  assert.deepEqual(
    describeAccountClients({ registeredVia:'web', clientsSeen:['web'], pushDestinations:[{ platform:'ios' }] }),
    { registeredVia: 'web', clientsSeen: ['ios', 'web'], usesApp: true });
  assert.deepEqual(describeAccountClients({ registeredVia:'web', clientsSeen:['web'] }), { registeredVia:'web', clientsSeen:['web'], usesApp:false });
});

test('PostgreSQL stores and restores both fields, and never overwrites where an identity was created', async () => {
  const calls = [];
  const pool = { query: async (...args) => { calls.push(args); return { rows:[] }; } };
  const store = new PostgresStore('', { pool });
  await store.initialize();
  await store.saveAccount('a'.repeat(64), {
    privateNumber:'2345678901', displayName:'Test', authVerifier:'auth', recoveryVerifier:'recovery',
    passwordWrap:'pw', recoveryWrap:'rw', bundle:'cipher', revision:1, sessions:[], connectionRequests:[],
    registeredVia:'android', clientsSeen:['android', 'web'], createdAt:1, updatedAt:1,
  });
  const upsert = calls.find(call => /ON CONFLICT \(account_id\) DO UPDATE/.test(call[0]));
  assert.match(upsert[0], /registered_via, clients_seen/);
  assert.match(upsert[0], /registered_via=COALESCE\(accounts\.registered_via, EXCLUDED\.registered_via\)/);
  assert.match(upsert[0], /\$30,\$31::jsonb\)/);
  assert.equal(upsert[1][29], 'android');
  assert.equal(upsert[1][30], JSON.stringify(['android', 'web']));
  assert.match(fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8'), /ADD COLUMN IF NOT EXISTS registered_via varchar\(16\);\s*ALTER TABLE accounts ADD COLUMN IF NOT EXISTS clients_seen jsonb/);

  const row = {
    account_id:'a'.repeat(64), private_number:'2345678901', display_name:'Test', revision:1, last_active_at:1,
    created_at:1, updated_at:1, creation_order:1, registered_via:'ios', clients_seen:['ios'],
  };
  const loader = new PostgresStore('', { pool:{ query: async () => ({ rows:[row] }) } });
  const [[, loaded]] = await loader.loadAccounts();
  assert.equal(loaded.registeredVia, 'ios');
  assert.deepEqual(loaded.clientsSeen, ['ios']);
  const legacy = new PostgresStore('', { pool:{ query: async () => ({ rows:[{ ...row, registered_via:null, clients_seen:null }] }) } });
  const [[, legacyLoaded]] = await legacy.loadAccounts();
  assert.equal(legacyLoaded.registeredVia, null);
  assert.deepEqual(legacyLoaded.clientsSeen, []);
});

test('the admin page shows where each identity signed up and which clients it has used', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'client', 'admin.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'client', 'admin.js'), 'utf8');
  assert.match(html, /<th>Private Number<\/th><th>Signed up via<\/th><th>Created<\/th>/);
  const start = js.indexOf('const CLIENT_LABELS');
  const source = js.slice(start, js.indexOf('function renderIdentities'));
  const context = vm.createContext({ escapeHtml: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`) });
  vm.runInContext(source + '\nthis.clientCell = clientCell;', context);
  const cell = identity => context.clientCell(identity);
  assert.equal(cell({ registeredVia:'web', clientsSeen:['web'] }), '<strong>Web</strong>');
  assert.equal(cell({ registeredVia:'web', clientsSeen:['ios', 'web'] }), '<strong>Web</strong><br><small>Also iOS app</small>');
  assert.equal(cell({ registeredVia:'android', clientsSeen:['android'] }), '<strong>Android app</strong>');
  assert.equal(cell({ registeredVia:null, clientsSeen:['android'] }), '<strong>Not recorded</strong><br><small>Used Android app</small>');
  assert.equal(cell({ registeredVia:null, clientsSeen:[] }), '<strong>Unknown</strong>');
  assert.match(js, /used the app · .* signed up on the web/);
});

// ── Whole server ──
async function freePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  return port;
}
const post = async (base, route, body, userAgent) => {
  const response = await fetch(base + route, { method:'POST', headers:{ 'content-type':'application/json', 'user-agent':userAgent }, body:JSON.stringify(body) });
  return { status:response.status, data:await response.json().catch(() => ({})) };
};

test('sign-up and sign-in record the client, and the admin list reports it', { timeout:30000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'vaultlix-clients-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const adminKey = 'test-admin-clients-key';
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:path.join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', PORT:String(port), SNAPSHOT_DIR:snapshotDir, ADMIN_KEY:adminKey, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
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
  const credentials = (letter, number) => ({
    accountId:letter.repeat(64), privateNumber:number, displayName:`User ${letter}`,
    authSecret:`auth-${letter}`.padEnd(48, letter), recoverySecret:`recovery-${letter}`.padEnd(48, letter),
    passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
  });
  const web = credentials('a', '2345678901');
  const app = credentials('b', '2345678902');
  assert.equal((await post(base, '/api/account/register', web, ANDROID_CHROME)).status, 200);
  assert.equal((await post(base, '/api/account/register', app, IOS_APP)).status, 200);
  // Signing in to the web account from the Android app later adds a client, but never changes where it was created.
  const login = await post(base, '/api/account/login', { privateNumber:web.privateNumber, authSecret:web.authSecret }, ANDROID_APP);
  assert.equal(login.status, 200);
  // A repeat sign-in from a client already on record changes nothing.
  assert.equal((await post(base, '/api/account/login', { privateNumber:web.privateNumber, authSecret:web.authSecret }, ANDROID_APP)).status, 200);

  const response = await fetch(`${base}/api/admin/stats`, { headers:{ Authorization:`Bearer ${adminKey}` } });
  assert.equal(response.status, 200);
  const { identities } = await response.json();
  const webIdentity = identities.find(entry => entry.privateNumber === web.privateNumber);
  const appIdentity = identities.find(entry => entry.privateNumber === app.privateNumber);
  assert.equal(webIdentity.registeredVia, 'web');
  assert.deepEqual(webIdentity.clientsSeen, ['android', 'web']);
  assert.equal(webIdentity.usesApp, true);
  assert.equal(appIdentity.registeredVia, 'ios');
  assert.deepEqual(appIdentity.clientsSeen, ['ios']);
  assert.equal(appIdentity.usesApp, true);
  for (const identity of identities) {
    assert.ok(!('userAgent' in identity), 'the user agent itself is never exposed or stored');
  }
});
