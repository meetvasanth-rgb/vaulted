'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

// Bug: the Calls tab aggregates call history from every room's
// room.messages (callHistoryEntries), but that array is only eagerly
// restored for the single last-active room at startup — every other room
// stays empty until the user happens to have manually opened that specific
// chat this session, so opening Calls early showed only one peer's calls.
// renderCallHistoryList now kicks off restoreRoomHistoryInBackground for
// any room still missing it; that function's own completion hook already
// re-renders the vault list, so no extra render-wiring was needed.
test('renderCallHistoryList kicks off history restoration for every room still missing it, not just the active one', () => {
  const start = client.indexOf('function renderCallHistoryList(body) {');
  assert.notEqual(start, -1);
  const end = client.indexOf('\nfunction ', start + 1);
  const source = client.slice(start, end);
  assert.match(source, /for \(const room of rooms\.values\(\)\) \{\s*\n\s*if \(!room\.historyLoaded && !room\.historyRestorePromise\) restoreRoomHistoryInBackground\(room\);\s*\n\s*\}/);
  // Must run before callHistoryEntries() reads room.messages, not after —
  // indexOf('callHistoryEntries()') alone would match this file's own
  // leading comment referencing that function by name, so anchor on the
  // actual call statement instead.
  assert.ok(source.indexOf('restoreRoomHistoryInBackground(room)') < source.indexOf('const entries = callHistoryEntries()'));
});

test('the restoration kickoff never re-triggers a room that already has history loaded or is mid-restore', () => {
  const start = client.indexOf('function restoreRoomHistoryInBackground(');
  assert.notEqual(start, -1);
  const end = client.indexOf('\n}', start) + 2;
  const source = client.slice(start, end);
  // Re-entrancy guard restoreCallsFix relies on: calling this again for a
  // room that's already mid-restore must return the SAME in-flight promise
  // rather than starting a second, duplicate /api/poll.
  assert.match(source, /if \(!room \|\| room\.historyRestorePromise\) return room\?\.historyRestorePromise \|\| null;/);
});

test('restoreRoomHistoryInBackground already re-renders the vault list on completion, which is what makes the Calls tab update once restoration finishes', () => {
  const start = client.indexOf('function restoreRoomHistoryInBackground(');
  const end = client.indexOf('\n}', start) + 2;
  const source = client.slice(start, end);
  assert.match(source, /document\.getElementById\('s-vault-list'\)\?\.classList\.contains\('active'\)/);
  assert.match(source, /renderVaultList\(\);/);
});
