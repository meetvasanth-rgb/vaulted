const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('five-digit preferences use expiring PostgreSQL reservations without number-style clutter', () => {
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS private_number_reservations/);
  assert.match(postgres, /reserved_until bigint NOT NULL/);
  assert.match(server, /PRIVATE_NUMBER_RESERVATION_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(server, /verifyPrivateNumberReservation\(privateNumber, d\.reservationToken\)/);
  assert.match(client, /reservationToken: pendingPrivateNumberReservation/);
  assert.match(client, /id="account-private-number-preference"/);
  assert.match(client, /Optional: choose the final five digits/);
  assert.doesNotMatch(client, /Short &middot; 6 digits/);
  assert.doesNotMatch(client, /Four zeros|Number sequence|Repeated digits|Repeated pairs/);
  assert.match(server, /normalizePreferredSuffix\(d\.preferredSuffix\)/);
});

test('strong recovery material remains encrypted locally while backup is deferred', () => {
  assert.match(client, /recoveryCodeWrap = await aesEncryptJson\(masterKey, \{ recoveryCode \}\)/);
  assert.match(client, /accountBundleSnapshot\(accountId, true, recoveryCodeWrap\)/);
  assert.match(client, /recoveryBackupConfirmedAt:0/);
  assert.match(client, /crypto\.getRandomValues\(new Uint8Array\(32\)\)/);
  assert.match(client, /if \(raw\.length !== 32\) throw new Error\('Invalid recovery code'\)/);
  assert.match(client, /authorizeRecoveryCodeAccess/);
  assert.match(client, /finishAccountCreation\(false\)/);
  assert.match(client, /I’ve saved it/);
});
