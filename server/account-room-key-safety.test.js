'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('a newer account snapshot cannot overwrite a complete keypair already working on this device', () => {
  assert.match(client, /const cryptoSource = validStoredRoomKeyPair\(current\) \? current : ownedSession/);
  assert.match(client, /token:cryptoSource\.token, pubJwk:cryptoSource\.pubJwk, privJwk:cryptoSource\.privJwk/);
  assert.match(client, /lastKnownPeerPubKey:cryptoSource\.lastKnownPeerPubKey/);
});

test('a fresh device still adopts the complete encrypted-backup keypair', () => {
  assert.match(client, /function validStoredRoomKeyPair\(session\)[\s\S]*session\.privJwk\.x === session\.pubJwk\.x[\s\S]*session\.privJwk\.y === session\.pubJwk\.y/);
  assert.match(client, /const cryptoSource = validStoredRoomKeyPair\(current\) \? current : ownedSession/);
});

test('a different backed-up key is adopted only after it authenticates existing ciphertext', () => {
  const start = client.indexOf('async function repairRoomKeyFromAccountBackup(room, messages)');
  const end = client.indexOf('async function loadEarlierMessages', start);
  const repair = client.slice(start, end);
  assert.match(repair, /candidate\.privJwk\.d === localPrivate\?\.d/);
  const proofAt = repair.indexOf('await decryptMsgWithSharedKey(derived.sharedKey, sample.content)');
  const adoptAt = repair.indexOf('room.myKeyPair = derived.pair');
  assert.ok(proofAt > -1 && adoptAt > proofAt, 'AES-GCM authentication must succeed before the candidate key is persisted');
  assert.match(repair, /await persistRoom\(room\)/);
});

test('history restore checks for a proven backup repair before rendering blocked records', () => {
  const start = client.indexOf('async function restoreRoomHistory(room)');
  const end = client.indexOf('function restoreRoomHistoryInBackground', start);
  const restore = client.slice(start, end);
  assert.ok(restore.indexOf('await repairRoomKeyFromAccountBackup(room, data.messages)') < restore.indexOf('await applyRestoredHistory(room, data.messages'),
    'key repair must run before ciphertext is turned into blocked records');
});
