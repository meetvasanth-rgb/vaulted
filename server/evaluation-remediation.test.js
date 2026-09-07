'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
const server = readFileSync(join(__dirname, 'index.js'), 'utf8');

test('profile lookup rate limiting reads the headers supplied to the API dispatcher', () => {
  assert.match(server, /function profileLookupRetryAfter\(headers, ip\)/);
  assert.match(server, /profileLookupRetryAfter\(headers, ip\)/);
  assert.doesNotMatch(server, /profileLookupRetryAfter\(req, ip\)/);
});

test('Find person keeps a persistent error in the dialog and coalesces duplicate lookups', () => {
  assert.match(client, /id="new-connection-error" role="alert" aria-live="assertive"/);
  assert.match(client, /openPublicProfile\(privateNumber, \{ keepConnectionSheet:true \}\)/);
  assert.match(client, /if \(publicProfileLookup\?\.privateNumber === normalized\) return publicProfileLookup\.promise/);
  assert.match(client, /if \(opened\) closeNewConnection\(\)/);
});

test('signed-out UI does not hydrate or render locally retained conversations', () => {
  assert.match(client, /if \(!loadAccountState\(\)\) \{[\s\S]*Sign in to view your private lines/);
  assert.match(client, /const idx = startupAccount[\s\S]*\? loadRoomsIndex\(\)\.filter/);
  assert.match(client, /const localCodes = \[\.\.\.new Set\(\[\.\.\.loadRoomsIndex\(\), \.\.\.rooms\.keys\(\)\]\)\]/);
  assert.match(client, /saveRoomsIndex\(\[\]\);[\s\S]*saveActiveRoomCode\(null\)/);
});

test('App Lock describes its screen-lock boundary accurately', () => {
  assert.match(client, /App Lock protects the screen; it does not separately encrypt browser storage\./);
});

test('authenticated launch paints the local inbox before network restoration', () => {
  assert.match(client, /rel="stylesheet" media="print" onload="this\.media='all'"/);
  assert.match(client, /window\.addEventListener\('DOMContentLoaded', async \(\) => \{/);
  assert.match(client, /window\.addEventListener\('DOMContentLoaded', \(\) => \{\s*try \{ window\.webkit\?\.messageHandlers\?\.vaultlixCall/);
  const hydrateAt = client.indexOf('room.restorePending = true;');
  const revealAt = client.indexOf("showScreen('s-vault-list');", hydrateAt);
  const joinAt = client.indexOf("const result = await api('/api/join'", hydrateAt);
  assert.ok(hydrateAt > -1 && revealAt > hydrateAt && joinAt > revealAt,
    'local room metadata must be visible before the first server join');
  assert.match(client, /if \(room\?\.restorePending\) \{[\s\S]*Opening this private conversation securely/);
});
