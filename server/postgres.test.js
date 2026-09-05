'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore, SCHEMA_SQL } = require('./postgres');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const server = readFileSync(join(__dirname, 'index.js'), 'utf8');

test('v2 schema stores only ciphertext and supports deletion synchronization', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS encrypted_messages/);
  assert.match(SCHEMA_SQL, /ciphertext text NOT NULL/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS deletion_tombstones/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS device_sync_cursors/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS account_inbox_counters/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS message_receipts/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS message_reactions/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS private_number_lifecycle/);
  assert.match(SCHEMA_SQL, /last_active_at bigint/);
  assert.match(SCHEMA_SQL, /number_protection varchar/);
  assert.doesNotMatch(SCHEMA_SQL, /message_plaintext|plaintext_message|decrypted_content/);
});

test('conversation writes hash bearer tokens and deletion is transactional', async () => {
  const calls = [];
  const client = { query:async (...args) => { calls.push(args); return { rows:[] }; }, release:() => calls.push(['RELEASE']) };
  const pool = { query:client.query, connect:async () => client };
  const store = new PostgresStore('', { pool });
  await store.createConversation({ id:'room-1', persistent:true, createdAt:1 });
  await store.upsertConversationMember('room-1', 1, 'bearer-secret', { name:'cipher-name', lastSeen:1 });
  assert.equal(calls[1][1][2], require('crypto').createHash('sha256').update('bearer-secret').digest('hex'));
  assert.notEqual(calls[1][1][2], 'bearer-secret');
  await store.deleteConversationMember('room-1', 1);
  assert.match(calls[2][0], /DELETE FROM conversation_members/);
  await store.appendEncryptedMessage('room-1', 'bearer-secret', { id:'message-1', seq:1, content:'ciphertext', ts:2 });
  assert.match(calls.at(-5)[0], /BEGIN/);
  assert.match(calls.at(-4)[0], /INSERT INTO encrypted_messages/);
  assert.match(calls.at(-3)[0], /UPDATE conversations/);
  assert.equal(calls.at(-2)[0], 'COMMIT');
  assert.equal(calls.at(-1)[0], 'RELEASE');
  await store.deleteEncryptedMessage('room-1', 'message-1', 3, 10, 1000);
  assert.equal(calls.at(-5)[0], 'BEGIN');
  assert.match(calls.at(-4)[0], /DELETE FROM encrypted_messages/);
  assert.match(calls.at(-3)[0], /INSERT INTO deletion_tombstones/);
  assert.equal(calls.at(-2)[0], 'COMMIT');
  assert.equal(calls.at(-1)[0], 'RELEASE');
});

test('account persistence uses parameterized upserts', async () => {
  const calls = [];
  const pool = { query:async (...args) => { calls.push(args); return { rows:[] }; } };
  const store = new PostgresStore('', { pool });
  await store.initialize();
  await store.saveAccount('a'.repeat(64), {
    privateNumber:'2345678901', displayName:'Test', authVerifier:'auth', recoveryVerifier:'recovery',
    passwordWrap:'pw', recoveryWrap:'rw', bundle:'cipher', revision:1,
    sessions:[], connectionRequests:[], createdAt:1, updatedAt:1,
  });
  assert.equal(calls.length, 2);
  assert.match(calls[1][0], /ON CONFLICT \(account_id\) DO UPDATE/);
  assert.equal(calls[1][1][0], 'a'.repeat(64));
});

test('production startup fails closed and account mutations await PostgreSQL', () => {
  assert.match(server, /await postgresStore\.initialize\(\)/);
  assert.match(server, /hydrateAccounts\(await postgresStore\.loadAccounts\(\), 'PostgreSQL'\)/);
  assert.match(server, /bootstrap\(\)\.catch\(err => \{[\s\S]*process\.exit\(1\)/);
  assert.match(server, /await persistAccount\(d\.accountId\)/);
  assert.match(server, /await releaseAccountNumber\(d\.accountId, account, 'account-deleted'\)/);
  assert.match(server, /await postgresStore\.appendEncryptedMessage\(d\.code, d\.token, message\)/);
  assert.match(server, /await postgresStore\.deleteEncryptedMessage\(d\.code, msg\.id/);
});

test('Private Number release is transactional and records quarantine or retirement first', async () => {
  const calls = [];
  const client = { query:async (...args) => { calls.push(args); return { rows:[] }; }, release:() => calls.push(['RELEASE']) };
  const pool = { connect:async () => client };
  const store = new PostgresStore('', { pool });
  await store.releasePrivateNumber('a'.repeat(64), '2345678901', {
    status:'quarantined', availableAfter:1234, reason:'inactivity', createdAt:100,
  });
  assert.equal(calls[0][0], 'BEGIN');
  assert.match(calls[1][0], /INSERT INTO private_number_lifecycle/);
  assert.match(calls[2][0], /DELETE FROM accounts/);
  assert.equal(calls[3][0], 'COMMIT');
  assert.equal(calls[4][0], 'RELEASE');
});
