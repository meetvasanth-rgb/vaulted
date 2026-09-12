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

test('durable ciphertext history can rebuild a stale live-room checkpoint', async () => {
  const calls = [];
  const pool = { query:async (...args) => {
    calls.push(args);
    return { rows:[{
      conversation_id:'room-1', message_id:'message-1',
      sender_token_hash:'a'.repeat(64), sequence:'7', ciphertext:'ciphertext',
      created_at:'1234', expires_at:null, view_once:false,
    }] };
  } };
  const store = new PostgresStore('', { pool });
  const messages = await store.loadEncryptedMessages('room-1', 100, 999);
  assert.deepEqual(messages, [{
    id:'message-1', senderTokenHash:'a'.repeat(64), seq:7,
    content:'ciphertext', ts:1234, expiresAt:null, viewOnce:false,
  }]);
  assert.match(calls[0][0], /ORDER BY sequence DESC[\s\S]*LIMIT \$3/);
  assert.match(calls[0][0], /ORDER BY sequence ASC/);
  assert.deepEqual(calls[0][1], ['room-1', 999, 100]);
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

test('Daily Look claim uses the current midnight-reset window in PostgreSQL', async () => {
  const calls = [];
  const pool = { query:async (...args) => {
    calls.push(args);
    return { rows:[{ account_id:'a'.repeat(64) }] };
  } };
  const store = new PostgresStore('', { pool });
  const claimed = await store.claimDailyLook('a'.repeat(64), 2000, 1000, 1500, 5);
  assert.equal(claimed, true);
  assert.match(calls[0][0], /daily_look_window_started_at <> \$3/);
  assert.deepEqual(calls[0][1], ['a'.repeat(64), 2000, 1000, 1500, 5]);
});

test('Private Number reservation pins PostgreSQL parameter types across identity tables', async () => {
  const calls = [];
  const pool = { query:async (...args) => { calls.push(args); return { rows:[{ private_number:'2345678901' }] }; } };
  const store = new PostgresStore('', { pool });
  const reserved = await store.reservePrivateNumber('2345678901', 'a'.repeat(64), 'standard', 200);
  assert.equal(reserved, true);
  assert.match(calls[0][0], /\$1::varchar\(10\)/);
  assert.match(calls[0][0], /\$2::char\(64\)/);
  assert.match(calls[0][0], /\$4::bigint/);
  assert.match(calls[0][0], /reserved_until < \$5::bigint/);
});

test('production startup fails closed and account mutations await PostgreSQL', () => {
  assert.match(server, /await postgresStore\.initialize\(\)/);
  assert.match(server, /hydrateAccounts\(await postgresStore\.loadAccounts\(\), 'PostgreSQL'\)/);
  assert.match(server, /bootstrap\(\)\.catch\(err => \{[\s\S]*process\.exit\(1\)/);
  assert.match(server, /await persistAccount\(d\.accountId\)/);
  assert.match(server, /await releaseAccountNumber\(d\.accountId, account, 'account-deleted'\)/);
  assert.match(server, /await postgresStore\.appendEncryptedMessage\(d\.code, d\.token, message\)/);
  assert.match(server, /if \(includeOwn\) await hydrateRoomMessagesFromPostgres\(roomCode, room\)/);
  assert.match(server, /await postgresStore\.deleteEncryptedMessage\(d\.code, msg\.id/);
});

test('Private Number retirement is transactional and records its tombstone first', async () => {
  const calls = [];
  const client = { query:async (...args) => { calls.push(args); return { rows:[] }; }, release:() => calls.push(['RELEASE']) };
  const pool = { connect:async () => client };
  const store = new PostgresStore('', { pool });
  await store.releasePrivateNumber('a'.repeat(64), '2345678901', {
    status:'retired', availableAfter:null, reason:'inactivity', createdAt:100,
  });
  assert.equal(calls[0][0], 'BEGIN');
  assert.match(calls[1][0], /INSERT INTO private_number_lifecycle/);
  assert.match(calls[2][0], /DELETE FROM accounts/);
  assert.equal(calls[3][0], 'COMMIT');
  assert.equal(calls[4][0], 'RELEASE');
});
