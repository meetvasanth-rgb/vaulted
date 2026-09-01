'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PostgresStore, SCHEMA_SQL } = require('./postgres');

test('v2 schema stores only ciphertext and supports deletion synchronization', () => {
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS encrypted_messages/);
  assert.match(SCHEMA_SQL, /ciphertext text NOT NULL/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS deletion_tombstones/);
  assert.match(SCHEMA_SQL, /CREATE TABLE IF NOT EXISTS device_sync_cursors/);
  assert.doesNotMatch(SCHEMA_SQL, /message_plaintext|plaintext_message|decrypted_content/);
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
