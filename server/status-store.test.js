'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StatusStore, STATUS_TTL_MS, SCHEMA } = require('./status-store');

test('encrypted status lifecycle is recipient-scoped and expires after 24 hours', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vaultlix-status-'));
  const store = new StatusStore(directory);
  await store.initialize();
  const createdAt = 1_800_000_000_000;
  const status = await store.publish('author', [
    { recipientId:'friend-a', code:'room-a', ciphertext:'v:cipher-a' },
    { recipientId:'friend-b', code:'room-b', ciphertext:'v:cipher-b' },
  ], createdAt);

  assert.equal(status.expiresAt, createdAt + STATUS_TTL_MS);
  assert.equal((await store.listFor('friend-a', createdAt + 1))[0].entries[0].ciphertext, 'v:cipher-a');
  assert.equal((await store.listFor('stranger', createdAt + 1)).length, 0);
  assert.equal(await store.markViewed(status.id, 'friend-a', createdAt + 2), true);
  assert.equal(await store.markViewed(status.id, 'friend-a', createdAt + 3), true);
  const authorFeed = await store.listFor('author', createdAt + 4);
  assert.deepEqual(authorFeed[0].viewers.map(viewer => viewer.accountId), ['friend-a']);
  assert.equal((await store.listFor('friend-a', status.expiresAt)).length, 0);
  fs.rmSync(directory, { recursive:true, force:true });
});

test('status schema stores only encrypted entries and viewer metadata', () => {
  assert.match(SCHEMA, /CREATE TABLE IF NOT EXISTS encrypted_statuses/);
  assert.match(SCHEMA, /entries jsonb NOT NULL/);
  assert.doesNotMatch(SCHEMA, /plaintext|status_text|status_image/);
});
