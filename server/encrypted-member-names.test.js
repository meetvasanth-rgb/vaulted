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

test('an encrypted current peer name cannot be replaced by stale plaintext metadata', () => {
  assert.match(client, /peerNameEncrypted: peerNameEncrypted === true/);
  assert.match(client, /peerNameEncrypted: room\.peerNameEncrypted === true/);
  assert.match(client, /room\.peerNameEncrypted = true/);
  assert.match(client, /!room\.peerNameEncrypted && !data\.peerNameCiphertext && data\.peerName/);
  assert.match(client, /!room\.peerNameEncrypted && !result\.peerNameCiphertext && result\.peerName/);
  assert.match(client, /setStatus\(data\.peerOnline, room\.peerName\)/);
  assert.doesNotMatch(client, /if \(data\.peerName\) room\.peerName = data\.peerName/);
});

test('the current accepted-account profile outranks an older per-room encrypted name', () => {
  assert.match(client, /peerNameFromAccountProfile: peerNameFromAccountProfile === true/);
  assert.match(client, /peerNameFromAccountProfile: room\.peerNameFromAccountProfile === true/);
  assert.match(client, /if \(room\.peerNameFromAccountProfile\) return true/);
  assert.match(client, /peer\.displayName && \(room\.peerName !== peer\.displayName \|\| !room\.peerNameFromAccountProfile\)/);
  assert.match(client, /room\.peerNameFromAccountProfile = true/);
});

test('profile renames repair every local conversation linked to the same Vaultlix number', () => {
  assert.match(client, /const relatedRooms = new Set\(\)/);
  assert.match(client, /normalizePrivateNumber\(candidate\.peerPrivateNumber\) === peer\.privateNumber/);
  assert.match(client, /for \(const room of relatedRooms\)/);
});
