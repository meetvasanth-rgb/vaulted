'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('clients encrypt member names only after the conversation key exists', () => {
  assert.match(client, /async function publishEncryptedMemberName\(room\)[\s\S]*encryptMsg\(room, JSON\.stringify\(\{ type:'member-name', name:normalizedName \}\)\)/);
  assert.match(client, /await api\('\/api\/member-name', \{ code:room\.code, token:room\.token, ciphertext \}\)/);
  assert.match(client, /room\.sharedKey = await crypto\.subtle\.deriveKey[\s\S]*publishEncryptedMemberName\(room\)\.catch/);
  assert.match(client, /async function applyEncryptedPeerName\(room, ciphertext\)[\s\S]*decryptMsg\(room, ciphertext\)/);
});

test('server accepts only authenticated E2E name envelopes and relays them opaquely', () => {
  assert.match(server, /path==='\/api\/member-name'[\s\S]*room\.members\.has\(d\.token\)/);
  assert.match(server, /ciphertext\.startsWith\('v:'\)/);
  assert.match(server, /member\.nameCiphertext = ciphertext/);
  assert.match(server, /peerNameCiphertext/);
  assert.match(server, /'\/api\/notification-privacy', '\/api\/member-name'/);
});
