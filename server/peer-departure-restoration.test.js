'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('an established conversation keeps the peer identity after their device is erased', () => {
  assert.match(client, /peerName: room\.peerName \|\| null/);
  assert.match(client, /everOnline: !!room\.everOnline/);
  assert.match(client, /makeRoom\(\{ code: session\.code[\s\S]*peerName:session\.peerName, everOnline:session\.everOnline/);
});

test('a completed handshake is persisted before the conversation can be restored', () => {
  assert.match(client, /room\.peerOnline = true; room\.everOnline = true; room\.peerName = d\.peerName;[\s\S]*await persistRoom\(room\);[\s\S]*setActiveRoom\(room\.code\)/);
  assert.match(client, /room\.peerOnline = true; room\.everOnline = true;[\s\S]*await persistRoom\(room\);[\s\S]*setActiveRoom\(room\.code\)/);
});

test('an established restored conversation cannot reopen the legacy share-room screen', () => {
  assert.match(client, /if \(room && !room\.everOnline\) resumeWaitingScreen\(room\)/);
  assert.match(client, /everOnline: !!everOnline/);
});

test('older snapshots are repaired from the accepted connection identity', () => {
  assert.match(client, /if \(peer\.displayName && room\.peerName !== peer\.displayName\) \{ room\.peerName = peer\.displayName; changed = true; \}/);
  assert.match(client, /if \(!room\.everOnline\) \{ room\.everOnline = true; changed = true; \}/);
  assert.match(client, /if \(changed\) await persistRoom\(room\)/);
});
