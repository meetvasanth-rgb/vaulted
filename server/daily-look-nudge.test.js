'use strict';

// A day after joining, a member who has a connection and has never made a Daily Look sees an inbox card
// suggesting it. The server says whether they are eligible; "Not now", opening it, or making a look ends it.

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

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function extractFunction(name, prefix = 'function') {
  const start = client.indexOf(`${prefix} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

function harness({ rooms = 1, groups = 0, status = { configured:true, available:true, createdAt:NOW - 3 * DAY, lastGeneratedAt:0 }, stored = {} } = {}) {
  const store = new Map(Object.entries(stored));
  const apiCalls = [];
  let statusResult = status;
  const context = vm.createContext({
    loadAccountState: () => ({ accountId:'acc1', sessionToken:'tok' }),
    rooms:{ size:rooms }, privateGroups:{ size:groups },
    localStorage:{ getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) },
    api: async (route, body) => { apiCalls.push([route, body]); if (statusResult instanceof Error) throw statusResult; return statusResult; },
    renderVaultList: () => { context.renders = (context.renders || 0) + 1; },
    openDailyLook: () => { context.opened = true; },
    Date, Number,
  });
  const source = [
    "const DAILY_LOOK_NUDGE_KEY_PREFIX = 'vaultlix_daily_look_nudge:'; const DAILY_LOOK_NUDGE_AFTER_MS = 24 * 60 * 60 * 1000; const DAILY_LOOK_NUDGE_RECHECK_MS = 6 * 60 * 60 * 1000;",
    'let dailyLookNudgeEligible = false; let dailyLookNudgeCheckedAt = 0; let dailyLookNudgeChecking = false;',
    ...['dailyLookNudgeKey', 'dailyLookNudgeEnded', 'endDailyLookNudge', 'dismissDailyLookNudge', 'tryDailyLookFromNudge', 'dailyLookNudgeHtml'].map(name => extractFunction(name)),
    extractFunction('refreshDailyLookNudge', 'async function'),
  ].join('\n');
  vm.runInContext(source, context);
  return { context, store, apiCalls, setStatus: value => { statusResult = value; } };
}

test('an eligible member with a connection gets the card, once the server says so', async () => {
  const h = harness();
  assert.equal(h.context.dailyLookNudgeHtml(), '', 'nothing before the server has been asked');
  await h.context.refreshDailyLookNudge(NOW);
  assert.deepEqual(h.apiCalls.map(call => call[0]), ['/api/account/daily-look/status']);
  const html = h.context.dailyLookNudgeHtml();
  assert.match(html, /Try Portrait Studio/);
  assert.match(html, /Your photo isn’t kept/);
  assert.match(html, /onclick="tryDailyLookFromNudge\(\)">Try it</);
  assert.match(html, /onclick="dismissDailyLookNudge\(\)">Not now</);
  assert.equal(h.context.renders, 1, 'the inbox is redrawn when the card becomes eligible');
});

test('the server decides: too new, already made one, switched off, or out of creations means no card', async () => {
  const cases = [
    { configured:true, available:true, createdAt:NOW - 12 * 60 * 60 * 1000, lastGeneratedAt:0 },
    { configured:true, available:true, createdAt:NOW - 3 * DAY, lastGeneratedAt:NOW - DAY },
    { configured:false, available:true, createdAt:NOW - 3 * DAY, lastGeneratedAt:0 },
    { configured:true, available:false, createdAt:NOW - 3 * DAY, lastGeneratedAt:0 },
    { configured:true, available:true, createdAt:0, lastGeneratedAt:0 },
    { error:'Your Vaultlix session has expired.' },
  ];
  for (const status of cases) {
    const h = harness({ status });
    await h.context.refreshDailyLookNudge(NOW);
    assert.equal(h.context.dailyLookNudgeHtml(), '', JSON.stringify(status));
  }
});

test('having made a look already ends the nudge for good, even from another device', async () => {
  const h = harness({ status:{ configured:true, available:true, createdAt:NOW - 3 * DAY, lastGeneratedAt:NOW - DAY } });
  await h.context.refreshDailyLookNudge(NOW);
  assert.equal(h.store.get('vaultlix_daily_look_nudge:acc1'), 'tried');
  await h.context.refreshDailyLookNudge(NOW + 10 * DAY);
  assert.equal(h.apiCalls.length, 1, 'never asked again');
});

test('no connection, no card, and no request to the server either', async () => {
  const h = harness({ rooms:0, groups:0 });
  await h.context.refreshDailyLookNudge(NOW);
  assert.equal(h.apiCalls.length, 0);
  assert.equal(h.context.dailyLookNudgeHtml(), '');
  const group = harness({ rooms:0, groups:1 });
  await group.context.refreshDailyLookNudge(NOW);
  assert.equal(group.apiCalls.length, 1, 'a group counts as a connection');
  assert.match(group.context.dailyLookNudgeHtml(), /Try Portrait Studio/);
});

test('the server is asked at most every six hours, and not twice at once', async () => {
  const h = harness();
  await Promise.all([h.context.refreshDailyLookNudge(NOW), h.context.refreshDailyLookNudge(NOW)]);
  assert.equal(h.apiCalls.length, 1);
  await h.context.refreshDailyLookNudge(NOW + 5 * 60 * 60 * 1000);
  assert.equal(h.apiCalls.length, 1, 'too soon');
  await h.context.refreshDailyLookNudge(NOW + 6 * 60 * 60 * 1000);
  assert.equal(h.apiCalls.length, 2);
});

test('a failed check changes nothing and is retried at the next check', async () => {
  const h = harness({ status:new Error('offline') });
  await h.context.refreshDailyLookNudge(NOW);
  assert.equal(h.context.dailyLookNudgeHtml(), '');
  h.setStatus({ configured:true, available:true, createdAt:NOW - 3 * DAY, lastGeneratedAt:0 });
  await h.context.refreshDailyLookNudge(NOW + 6 * 60 * 60 * 1000);
  assert.match(h.context.dailyLookNudgeHtml(), /Try Portrait Studio/);
});

test('"Not now" ends it for good and redraws; "Try it" opens Daily Look and ends it too', async () => {
  const dismissed = harness();
  await dismissed.context.refreshDailyLookNudge(NOW);
  dismissed.context.dismissDailyLookNudge();
  assert.equal(dismissed.store.get('vaultlix_daily_look_nudge:acc1'), 'dismissed');
  assert.equal(dismissed.context.dailyLookNudgeHtml(), '');
  await dismissed.context.refreshDailyLookNudge(NOW + 10 * DAY);
  assert.equal(dismissed.apiCalls.length, 1, 'a dismissed nudge never asks the server again');

  const tried = harness();
  await tried.context.refreshDailyLookNudge(NOW);
  tried.context.tryDailyLookFromNudge();
  assert.equal(tried.context.opened, true);
  assert.equal(tried.store.get('vaultlix_daily_look_nudge:acc1'), 'tried');
  assert.equal(tried.context.dailyLookNudgeHtml(), '');
});

test('an earlier decision on this device is respected, per account', async () => {
  const h = harness({ stored:{ 'vaultlix_daily_look_nudge:acc1':'dismissed' } });
  await h.context.refreshDailyLookNudge(NOW);
  assert.equal(h.apiCalls.length, 0);
  const other = harness({ stored:{ 'vaultlix_daily_look_nudge:someone-else':'dismissed' } });
  await other.context.refreshDailyLookNudge(NOW);
  assert.match(other.context.dailyLookNudgeHtml(), /Try Portrait Studio/);
});

test('wired into the inbox, ended by making a look, and kept apart from the invite card', () => {
  assert.match(client, /if \(!searchQuery\) refreshDailyLookNudge\(\)\.catch\(\(\) => \{\}\);/);
  assert.match(client, /inviteCardHtml\(\) \+ avatarOfferHtml\(\) \+ dailyLookNudgeHtml\(\) \+ requestsRowHtml\(\)/);
  const generate = client.slice(client.indexOf('async function generateDailyLook()'), client.indexOf('function showDailyLookResult'));
  assert.match(generate, /endDailyLookNudge\('tried'\);\s*await saveDailyLookResult/);
  // The invite card is for accounts with no chats; this card needs one: they never show together.
  assert.match(extractFunction('inviteCardHtml'), /rooms\.size > 0 \|\| privateGroups\.size > 0/);
  assert.match(extractFunction('dailyLookNudgeHtml'), /rooms\.size === 0 && privateGroups\.size === 0/);
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

test('the status route tells an account when it joined and when it last made a look', { timeout:20000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(path.join(tmpdir(), 'vaultlix-nudge-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:path.join(__dirname, '..'),
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
  const before = Date.now();
  const registered = await post(base, '/api/account/register', {
    accountId:'a'.repeat(64), privateNumber:'2345678901', displayName:'User a',
    authSecret:'auth-a'.padEnd(48, 'a'), recoverySecret:'recovery-a'.padEnd(48, 'a'),
    passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
  });
  assert.equal(registered.status, 200);
  const status = await post(base, '/api/account/daily-look/status', { accountId:registered.data.accountId, sessionToken:registered.data.sessionToken });
  assert.equal(status.status, 200);
  assert.ok(status.data.createdAt >= before - 1000 && status.data.createdAt <= Date.now() + 1000, 'the account\'s own creation time');
  assert.equal(status.data.lastGeneratedAt, 0, 'never made one');
  assert.equal((await post(base, '/api/account/daily-look/status', { accountId:registered.data.accountId, sessionToken:'wrong' })).status, 401);
});
