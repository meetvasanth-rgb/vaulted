'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('verified peer keys survive an offline restart without false secure-reconnection state', () => {
  assert.match(client, /lastKnownPeerPubKey: room\.lastKnownPeerPubKey \|\| null/);
  assert.match(client, /lastKnownPeerPubKey:session\.lastKnownPeerPubKey/);
  assert.match(client, /const peerPubKeyForRestore = result\.peerPubKey \|\| room\.lastKnownPeerPubKey/);
  assert.match(client, /await deriveSharedKey\(room, peerPubKeyForRestore\)/);
  assert.match(client, /data\.peerPubKey \|\| \(room\.sharedKey && room\.lastKnownPeerPubKey\)/);
  assert.match(client, /room\.reconnectRequired = !!\(room\.everOnline && result\.isReconnect !== true\)/);
  assert.doesNotMatch(client, /else if \(room\.everOnline\) room\.reconnectRequired = true/);
  assert.doesNotMatch(client, /room\.lastKnownPeerPubKey = null; \/\/ force key rederivation/);
});

test('a newly verified live peer key is durably saved', () => {
  assert.match(client, /room\.lastKnownPeerPubKey = data\.peerPubKey;[\s\S]{0,500}await persistRoom\(room\)/);
  assert.match(client, /room\.lastKnownPeerPubKey = peerPubKeyForRestore;[\s\S]{0,500}await persistRoom\(room\)/);
});
