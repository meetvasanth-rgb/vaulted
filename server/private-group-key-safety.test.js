'use strict';

// Regression tests for private-group key loss.
//
// A group's creator generates its key on their own device and has no
// server-side copy. A keyless record saved with a fresh timestamp used to
// outrank the encrypted backup that still held the real key, and the next
// sync then uploaded it over that backup. These tests run the real storage
// functions from client/index.html against that exact sequence.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groupsJs = readFileSync(join(__dirname, '..', 'client', 'groups.js'), 'utf8');

// Pull a top-level function's source out of the inline script by matching braces.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing from client/index.html`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} is not balanced`);
}

function sandbox(accountId = 'acc1') {
  const store = new Map();
  const context = vm.createContext({
    localStorage: { getItem: key => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, String(value)) },
    PRIVATE_GROUPS_KEY: 'groups',
    loadAccountState: () => ({ accountId }),
    privateGroups: new Map(),
  });
  for (const name of ['hasPrivateGroupKeys', 'mergePrivateGroupBackup', 'loadPrivateGroupSessions', 'savePrivateGroupSessions']) {
    vm.runInContext(extractFunction(client, name), context);
  }
  return { context, store, run: code => vm.runInContext(code, context) };
}

const group = (overrides = {}) => ({ id: 'G1', ownerAccountId: 'acc1', ownerId: 'acc1', keyBinding: 'kb', name: 'Own Test', keys: { 1: 'REAL-KEY-V1' }, keyVersion: 1, members: [], savedAt: 1000, ...overrides });

test('a group with no keys is not a usable record', () => {
  const { run } = sandbox();
  assert.equal(run('hasPrivateGroupKeys({ keys: {} })'), false);
  assert.equal(run('hasPrivateGroupKeys({})'), false);
  assert.equal(run('hasPrivateGroupKeys(null)'), false);
  assert.equal(run('hasPrivateGroupKeys({ keys: { 1: "k" } })'), true);
});

test('a legacy keyless record already in storage is ignored on load', () => {
  const { store, run } = sandbox();
  store.set('groups', JSON.stringify([{ id: 'G1', ownerAccountId: 'acc1', keys: {}, savedAt: 9e12 }]));
  // Length, not deepEqual: the array is created inside the vm sandbox, so it has a different Array prototype.
  assert.equal(run('loadPrivateGroupSessions().length'), 0);
});

test('saving never persists a group that has no keys', () => {
  const { store, run } = sandbox();
  run(`privateGroups.set('G1', { id: 'G1', ownerAccountId: 'acc1', name: 'Private group', keys: {}, keyVersion: 1 }); savePrivateGroupSessions();`);
  assert.deepEqual(JSON.parse(store.get('groups')), []);
});

test('saving never drops a key version that is already stored', () => {
  const { store, run } = sandbox();
  store.set('groups', JSON.stringify([group({ keys: { 1: 'REAL-KEY-V1' } })]));
  // In memory the group has lost its keys (or only knows a newer version).
  run(`privateGroups.set('G1', { id: 'G1', ownerAccountId: 'acc1', name: 'Private group', keys: {}, keyVersion: 1 }); savePrivateGroupSessions();`);
  assert.deepEqual(JSON.parse(store.get('groups'))[0].keys, { 1: 'REAL-KEY-V1' });
  run(`privateGroups.set('G1', { id: 'G1', ownerAccountId: 'acc1', name: 'Own Test', keys: { 2: 'KEY-V2' }, keyVersion: 2 }); savePrivateGroupSessions();`);
  assert.deepEqual(JSON.parse(store.get('groups'))[0].keys, { 1: 'REAL-KEY-V1', 2: 'KEY-V2' });
});

test('a group removed from memory on purpose is still dropped', () => {
  const { store, run } = sandbox();
  store.set('groups', JSON.stringify([group()]));
  run('savePrivateGroupSessions([])');
  assert.deepEqual(JSON.parse(store.get('groups')), []);
});

test('the reported sequence: a keyless refresh must not shadow the backup', () => {
  const { store, run } = sandbox();
  // 1. This device has no local copy; a refresh could not open a key and kept a keyless group in memory.
  run(`privateGroups.set('G1', { id: 'G1', ownerAccountId: 'acc1', name: 'Private group', keys: {}, keyVersion: 1 }); savePrivateGroupSessions();`);
  // 2. The encrypted backup, older than that save, still holds the real key.
  const backup = [group({ savedAt: Date.now() - 3600000 })];
  const restored = run(`(() => { const local = new Map(loadPrivateGroupSessions().map(g => [g.id, g])); return [...mergePrivateGroupBackup(local, ${JSON.stringify(backup)}, 'acc1').values()]; })()`);
  assert.deepEqual(JSON.parse(JSON.stringify(restored[0].keys)), { 1: 'REAL-KEY-V1' });
  assert.equal(store.get('groups'), '[]');
});

test('merging a backup keeps every key version, whichever copy is newer', () => {
  const { run } = sandbox();
  const local = new Map([['G1', group({ keys: { 2: 'KEY-V2' }, keyVersion: 2, savedAt: 5000 })]]);
  const backup = [group({ keys: { 1: 'REAL-KEY-V1' }, keyVersion: 1, savedAt: 1000 })];
  const merged = run(`mergePrivateGroupBackup(new Map(${JSON.stringify([...local])}), ${JSON.stringify(backup)}, 'acc1').get('G1')`);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.keys)), { 1: 'REAL-KEY-V1', 2: 'KEY-V2' });
  assert.equal(merged.keyVersion, 2);
});

test('merging ignores keyless and foreign-account backup entries', () => {
  const { run } = sandbox();
  const backup = [group({ keys: {} }), group({ id: 'G2', ownerAccountId: 'someone-else' })];
  assert.equal(run(`mergePrivateGroupBackup(new Map(), ${JSON.stringify(backup)}, 'acc1').size`), 0);
});

test('a device without keys does not read messages or advance past them', () => {
  const poll = groupsJs.slice(groupsJs.indexOf('async function pollPrivateGroup'));
  const guard = poll.indexOf('if (!hasPrivateGroupKeys(group))');
  assert.ok(guard > -1, 'pollPrivateGroup needs a no-keys guard');
  assert.ok(guard < poll.indexOf("api('/api/groups/messages'"), 'the guard must run before messages are fetched');
});

test('missing keys are restored from the encrypted backup, once, without writing to it', () => {
  const restore = groupsJs.slice(groupsJs.indexOf('async function restorePrivateGroupKeysFromBackup'), groupsJs.indexOf('async function refreshPrivateGroups'));
  assert.match(restore, /privateGroupBackupRestoreTried/);
  assert.match(restore, /\/api\/account\/fetch/);
  assert.match(restore, /aesDecryptJson\(base64UrlToBytes\(state\.masterKey\)/);
  assert.doesNotMatch(restore, /\/api\/account\/sync/);
  assert.match(groupsJs, /await restorePrivateGroupKeysFromBackup\(\)/);
});
