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
