'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GroupStore, SCHEMA } = require('./group-store');

test('private groups persist ciphertext and rotate keys after removal', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-groups-'));
  const store = new GroupStore(directory);
  await store.initialize();
  const ownerId = 'a'.repeat(64);
  const memberId = 'b'.repeat(64);
  const group = await store.create(ownerId, 'g1:encrypted-name-value', [
    { accountId:ownerId, role:'owner', active:true, keyVersion:1 },
    { accountId:memberId, role:'member', active:true, keyVersion:1, wrapRoomCode:'trusted-room', wrappedKey:'v:wrapped-key-material', wrappedKeys:{ 1:'v:wrapped-key-material' } },
  ], 'binding-key-123456789012', '123e4567-e89b-42d3-a456-426614174000');
  assert.equal((await store.listFor(memberId)).length, 1);
  await store.send(group.id, memberId, { id:'message_identifier_1', ciphertext:'g1:encrypted-message-value' }, 100);
  const rotated = await store.rekey(group.id, ownerId, memberId, 'g1:new-encrypted-name', [], 200);
  assert.equal(rotated.keyVersion, 2);
  assert.equal(rotated.members.find(member => member.accountId === memberId).active, false);
  assert.equal((await store.listFor(memberId)).length, 0);
  assert.equal(await store.send(group.id, memberId, { id:'message_identifier_2', ciphertext:'g1:blocked-message-value' }, 300), null);
});

test('private group schema stores opaque JSON records', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS private_groups/);
  assert.match(SCHEMA, /data jsonb NOT NULL/);
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS private_group_attachments/);
  assert.match(SCHEMA, /ciphertext_size bigint NOT NULL/);
  assert.match(SCHEMA, /group_id uuid NOT NULL REFERENCES private_groups\(id\) ON DELETE CASCADE/);
});

test('retrying a private group message id is idempotent', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-group-retry-'));
  const store = new GroupStore(directory);
  await store.initialize();
  const ownerId = 'a'.repeat(64);
  const group = await store.create(ownerId, 'g1:encrypted-name', [
    { accountId:ownerId, role:'owner', active:true, keyVersion:1 },
  ], 'group-key-binding');
  const message = { id:'stable_message_identifier', ciphertext:'g1:encrypted-payload', attachmentId:null };
  await store.send(group.id, ownerId, message, 100);
  await store.send(group.id, ownerId, message, 200);
  assert.equal((await store.get(group.id)).messages.length, 1);
});

test('group message times are unique and always rise, so no member can poll past a message', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-groups-'));
  const store = new GroupStore(directory);
  await store.initialize();
  const ownerId = 'a'.repeat(64);
  const group = await store.create(ownerId, 'g1:encrypted-name-value', [
    { accountId:ownerId, role:'owner', active:true, keyVersion:1 },
  ], 'binding-key-123456789012', '123e4567-e89b-42d3-a456-426614174001');
  const send = (id, now) => store.send(group.id, ownerId, { id, ciphertext:`g1:${id}` }, now);
  const first = await send('message_identifier_1', 1000);
  await send('message_identifier_2', 1000);          // same millisecond
  await send('message_identifier_3', 990);           // read the clock before waiting for its turn
  const last = await send('message_identifier_4', 5000);
  const times = (await store.get(group.id)).messages.map(message => message.createdAt);
  assert.deepEqual(times, [1000, 1001, 1002, 5000]);
  assert.equal(new Set(times).size, times.length);
  assert.deepEqual([...times].sort((a, b) => a - b), times, 'stored order is time order');
  assert.equal(first.updatedAt, 1000);
  assert.equal(last.updatedAt, 5000, 'the time reported back to the sender is the stored one');
  const repeated = await send('message_identifier_4', 9000); // a retry of a message already stored
  assert.equal((await store.get(group.id)).messages.length, 4);
  assert.ok(repeated);
});

test('delete for everyone removes only the sender\'s own messages from the server', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-groups-'));
  const store = new GroupStore(directory);
  await store.initialize();
  const ownerId = 'a'.repeat(64);
  const memberId = 'b'.repeat(64);
  const outsiderId = 'c'.repeat(64);
  const group = await store.create(ownerId, 'g1:encrypted-name-value', [
    { accountId:ownerId, role:'owner', active:true, keyVersion:1 },
    { accountId:memberId, role:'member', active:true, keyVersion:1, wrapRoomCode:'trusted-room', wrappedKey:'v:wrapped-key-material', wrappedKeys:{ 1:'v:wrapped-key-material' } },
  ], 'binding-key-123456789012', '123e4567-e89b-42d3-a456-426614174002');
  await store.send(group.id, ownerId, { id:'owner_message_1', ciphertext:'g1:one', attachmentId:'att-1' }, 100);
  await store.send(group.id, memberId, { id:'member_message_1', ciphertext:'g1:two' }, 200);
  await store.send(group.id, ownerId, { id:'owner_message_2', ciphertext:'g1:three' }, 300);

  const result = await store.deleteMessages(group.id, ownerId, ['owner_message_1', 'member_message_1', 'unknown_message', 42]);
  assert.deepEqual(result.removed, [{ id:'owner_message_1', attachmentId:'att-1' }], "someone else's message is never removed");
  const left = (await store.get(group.id)).messages.map(message => message.id);
  assert.deepEqual(left, ['member_message_1', 'owner_message_2']);

  assert.equal(await store.deleteMessages(group.id, outsiderId, ['owner_message_2']), null, 'a non-member cannot delete');
  assert.equal((await store.get(group.id)).messages.length, 2);
  assert.equal(await store.deleteMessages('missing-group', ownerId, ['x']), null);
  assert.deepEqual((await store.deleteMessages(group.id, ownerId, [])).removed, []);
});

test('deleting the newest message never lets a later one reuse its time', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-groups-'));
  const store = new GroupStore(directory);
  await store.initialize();
  const ownerId = 'a'.repeat(64);
  const group = await store.create(ownerId, 'g1:encrypted-name-value', [
    { accountId:ownerId, role:'owner', active:true, keyVersion:1 },
  ], 'binding-key-123456789012', '123e4567-e89b-42d3-a456-426614174003');
  await store.send(group.id, ownerId, { id:'m1', ciphertext:'g1:1' }, 100);
  await store.send(group.id, ownerId, { id:'m2', ciphertext:'g1:2' }, 5000);
  await store.deleteMessages(group.id, ownerId, ['m2']);
  await store.send(group.id, ownerId, { id:'m3', ciphertext:'g1:3' }, 4990); // clock read before m2's time
  const stored = await store.get(group.id);
  assert.equal(stored.lastMessageAt, 5001);
  assert.deepEqual(stored.messages.map(message => [message.id, message.createdAt]), [['m1', 100], ['m3', 5001]]);
});
