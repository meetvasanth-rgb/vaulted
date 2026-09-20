'use strict';

// The group owner can add people after the group exists. Adding rotates the
// group key: everyone already in gets the new key, the new people get ONLY the
// new key (so nothing said before they joined is readable by them), and the
// server never returns earlier messages to a member who joined later.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { GroupStore, MAX_GROUP_MEMBERS } = require('./group-store');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const id = letter => letter.repeat(64);

async function newGroup() {
  const store = new GroupStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-add-')));
  await store.initialize();
  const group = await store.create(id('a'), 'g1:name', [
    { accountId:id('a'), role:'owner', active:true, keyVersion:1, addedAt:1 },
    { accountId:id('b'), role:'member', active:true, keyVersion:1, wrapRoomCode:'room-b', wrappedKey:'wk-b-1', wrappedKeys:{ 1:'wk-b-1' }, addedAt:1 },
  ], 'binding-key-123456789012', '123e4567-e89b-42d3-a456-426614174000');
  return { store, group };
}
const envelopeFor = (accountId, room, key) => ({ accountId, wrapRoomCode:room, wrappedKey:key });
const addition = (accountId, room, key) => ({ accountId, wrapRoomCode:room, wrappedKey:key });

test('adding a person rotates the key, keeps everyone else, and gives the newcomer only the new key', async () => {
  const { store, group } = await newGroup();
  const updated = await store.rekey(group.id, id('a'), null, 'g1:name2',
    [envelopeFor(id('b'), 'room-b', 'wk-b-2')], 500, [addition(id('c'), 'room-c', 'wk-c-2')]);
  assert.equal(updated.keyVersion, 2);
  const c = updated.members.find(member => member.accountId === id('c'));
  assert.equal(c.active, true);
  assert.equal(c.role, 'member');
  assert.deepEqual(c.wrappedKeys, { 2:'wk-c-2' }, 'a new member must not receive the earlier key');
  assert.equal(c.addedAt, 500);
  const b = updated.members.find(member => member.accountId === id('b'));
  assert.deepEqual(b.wrappedKeys, { 1:'wk-b-1', 2:'wk-b-2' }, 'existing members keep old keys and gain the new one');
  assert.equal((await store.listFor(id('c'))).length, 1);
});

test('a person already in the group cannot be added again, and nothing changes', async () => {
  const { store, group } = await newGroup();
  const result = await store.rekey(group.id, id('a'), null, 'g1:name2',
    [envelopeFor(id('b'), 'room-b', 'wk-b-2')], 500, [addition(id('b'), 'room-b', 'wk-dup')]);
  assert.equal(result, null);
  assert.equal((await store.get(group.id)).keyVersion, 1);
});

test('adding fails unless every current member receives the new key', async () => {
  const { store, group } = await newGroup();
  assert.equal(await store.rekey(group.id, id('a'), null, 'g1:name2', [], 500, [addition(id('c'), 'room-c', 'wk')]), null);
});

test('only the owner can change membership, and the owner cannot be added as a member', async () => {
  const { store, group } = await newGroup();
  assert.equal(await store.rekey(group.id, id('b'), null, 'g1:n', [], 500, [addition(id('c'), 'room-c', 'wk')]), null);
  assert.equal(await store.rekey(group.id, id('a'), null, 'g1:n', [envelopeFor(id('b'), 'room-b', 'wk')], 500, [addition(id('a'), 'room-a', 'wk')]), null);
});

test('the same person cannot be added twice in one request', async () => {
  const { store, group } = await newGroup();
  const twice = [addition(id('c'), 'room-c', 'wk1'), addition(id('c'), 'room-c', 'wk2')];
  assert.equal(await store.rekey(group.id, id('a'), null, 'g1:n', [envelopeFor(id('b'), 'room-b', 'wk')], 500, twice), null);
});

test('a group cannot grow past its member limit', async () => {
  const store = new GroupStore(fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-add-cap-')));
  await store.initialize();
  const members = [{ accountId:id('a'), role:'owner', active:true, keyVersion:1, addedAt:1 }];
  const envelopes = [];
  for (let n = 0; n < MAX_GROUP_MEMBERS; n++) {
    const accountId = n.toString(16).padStart(64, '0');
    members.push({ accountId, role:'member', active:true, keyVersion:1, wrapRoomCode:`room-${n}`, wrappedKey:'wk', wrappedKeys:{ 1:'wk' }, addedAt:1 });
    envelopes.push(envelopeFor(accountId, `room-${n}`, 'wk2'));
  }
  const group = await store.create(id('a'), 'g1:name', members, 'binding-key-123456789012', '223e4567-e89b-42d3-a456-426614174000');
  assert.equal(await store.rekey(group.id, id('a'), null, 'g1:n', envelopes, 500, [addition(id('f'), 'room-f', 'wk')]), null);
});

test('a member who left can be added back and starts fresh', async () => {
  const { store, group } = await newGroup();
  await store.leave(group.id, id('b'), 300);
  const back = await store.rekey(group.id, id('a'), null, 'g1:n', [], 400, [addition(id('b'), 'room-b', 'wk-b-new')]);
  const b = back.members.filter(member => member.accountId === id('b'));
  assert.equal(b.length, 1, 'no duplicate member record');
  assert.equal(b[0].active, true);
  assert.deepEqual(b[0].wrappedKeys, { [back.keyVersion]:'wk-b-new' });
});

test('the server endpoint is owner-only and never returns pre-join messages', () => {
  const server = read('server/index.js');
  assert.match(server, /path === '\/api\/groups\/add-members' && method === 'POST'/);
  assert.match(server, /Only the group owner can add members/);
  assert.match(server, /acceptedStatusRecipient\(d\.accountId, roomCode\)/);
  assert.match(server, /A blocked contact cannot be added to a group/);
  assert.match(server, /message\.createdAt >= joinedAt/);
});

test('the members card closes when the chat behind it is tapped', () => {
  const client = read('client/index.html');
  assert.match(client, /id="group-members"[^>]*onclick="if\(event\.target===this\)closeGroupMembers\(\)"/);
  assert.match(client, /id="group-add-overlay"[^>]*onclick="if\(event\.target===this\)closeAddGroupMembers\(\)"/);
});

// ---- client: who can be offered as a new member ---------------------------
const groups = read('client/groups.js');
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
const sandbox = vm.createContext({ Set, String });
vm.runInContext(extract(groups, 'groupAddCandidates'), sandbox);
// Arrays made inside the sandbox come from another realm; round-trip them so deepEqual compares plain values.
const candidates = (group, list, account) => JSON.parse(vm.runInContext(
  `JSON.stringify(groupAddCandidates(${JSON.stringify(group)}, ${JSON.stringify(list)}, ${JSON.stringify(account)}).map(room => room.code))`, sandbox));

test('only connected contacts who are not already members are offered', () => {
  const group = { members:[
    { accountId:'me', wrapRoomCode:null, privateNumber:'1111' },
    { accountId:'x', wrapRoomCode:'room-x', privateNumber:'2222' },
  ] };
  const room = (code, extra = {}) => ({ code, sharedKey:true, peerPrivateNumber:code.replace('room-', '') + code.replace('room-', '') + '00', ownerAccountId:'me', reconnectRequired:false, ...extra });
  const list = [
    room('room-x', { peerPrivateNumber:'2222' }),                 // already in the group (by room)
    room('room-y', { peerPrivateNumber:'2222' }),                 // same person on a re-created conversation (by number)
    room('room-z'),                                               // a real candidate
    room('room-nokey', { sharedKey:false }),                      // not securely connected
    room('room-stale', { reconnectRequired:true }),               // needs reconnecting
    room('room-other', { ownerAccountId:'someone-else' }),        // belongs to another account
    room('room-anon', { peerPrivateNumber:'' }),                  // no identity to add
  ];
  assert.deepEqual(candidates(group, list, 'me'), ['room-z']);
});

