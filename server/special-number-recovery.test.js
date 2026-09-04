const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('early tester numbers use expiring PostgreSQL reservations', () => {
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS private_number_reservations/);
  assert.match(postgres, /reserved_until bigint NOT NULL/);
  assert.match(server, /PRIVATE_NUMBER_RESERVATION_TTL_MS = 5 \* 60 \* 1000/);
  assert.match(server, /verifyPrivateNumberReservation\(privateNumber, d\.reservationToken\)/);
  assert.match(client, /reservationToken: pendingPrivateNumberReservation/);
  assert.match(client, /Early Tester Reward/);
});

test('recovery code remains encrypted locally and requires backup acknowledgement', () => {
  assert.match(client, /recoveryCodeWrap:await aesEncryptJson\(masterKey/);
  assert.match(client, /recoveryBackupConfirmedAt:0/);
  assert.match(client, /authorizeRecoveryCodeAccess/);
  assert.match(client, /I saved these details outside this device/);
  assert.match(client, /save the recovery code outside this device/);
});
