'use strict';

// importAccountBundle() already field-merges deleteLedger (see
// delete-ledger.test.js) and lastReadSeq/unreadStateVersion (both already
// Math.max'd) rather than letting the whole session object get picked
// wholesale by whichever side has the newer savedAt. unread/
// unreadSystemCount/lastSeq did NOT get that same treatment — on a
// multi-device account, an older device's snapshot could resurrect a
// stale unread counter even after a newer device's lastReadSeq had
// already caught up to it: the exact same "unreadStateVersion already 2,
// so the migration never re-runs, but unread was never reconciled" bug
// already fixed for the single-device startup path (see
// unread-migration-diagnostic.test.js), just reachable from a second
// device instead of a stuck version flag.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

// Extracts just the merge-computation lines (not the whole importAccountBundle
// function, which needs localStorage/loadRoomsIndex/etc. stubbed) so they can
// be evaluated directly against hand-picked current/ownedSession/lastReadSeq
// values.
const start = client.indexOf('const lastSeq = Math.max(Number(current?.lastSeq)');
const end = client.indexOf('merged.set(session.code,', start);
assert.notEqual(start, -1, 'merge computation block missing');
const mergeLogic = client.slice(start, end);

function computeMerge(current, ownedSession, lastReadSeq) {
  const sandbox = vm.createContext({ Number, Math, current, ownedSession, lastReadSeq, result: {} });
  vm.runInContext(`${mergeLogic}\nresult = { lastSeq, unread, unreadSystemCount };`, sandbox);
  return sandbox.result;
}

test('lastSeq never regresses — merged value is the max of both sides', () => {
  const { lastSeq } = computeMerge({ lastSeq: 30 }, { lastSeq: 55 }, 30);
  assert.equal(lastSeq, 55);
  const { lastSeq: reversed } = computeMerge({ lastSeq: 55 }, { lastSeq: 30 }, 55);
  assert.equal(reversed, 55);
});

test('when the merged lastReadSeq has already caught up to the merged lastSeq, unread is forced to 0 regardless of either side\'s stored count', () => {
  // This is exactly the live bug: one side still has unread:9 from before
  // its migration ever ran, but lastReadSeq (merged, already Math.max'd
  // upstream of this logic) shows nothing is actually outstanding.
  const { unread, unreadSystemCount } = computeMerge(
    { lastSeq: 55, unread: 9, unreadSystemCount: 2 },
    { lastSeq: 40, unread: 0, unreadSystemCount: 0 },
    55, // merged lastReadSeq, already caught up to the merged lastSeq (55)
  );
  assert.equal(unread, 0);
  assert.equal(unreadSystemCount, 0);
});

test('when a genuine gap exists (lastReadSeq behind lastSeq), the SMALLER of the two counts wins, not whichever side was picked wholesale', () => {
  // Neither side is fully trusted outright — over-counting is the failure
  // mode being guarded against, so the more conservative (smaller) value
  // is kept rather than defaulting to whichever session "won" by savedAt.
  const { unread } = computeMerge(
    { lastSeq: 60, unread: 12 },
    { lastSeq: 60, unread: 3 },
    50, // behind lastSeq 60 — a real gap exists
  );
  assert.equal(unread, 3);
});

test('a brand-new room (no current local copy) takes the incoming session\'s own counts as-is, still subject to the same zero-when-caught-up invariant', () => {
  const freshNoGap = computeMerge(undefined, { lastSeq: 20, unread: 5, unreadSystemCount: 1 }, 20);
  assert.equal(freshNoGap.unread, 0, 'lastReadSeq already equals lastSeq, so even a fresh incoming count gets zeroed');
  const freshWithGap = computeMerge(undefined, { lastSeq: 20, unread: 5, unreadSystemCount: 1 }, 10);
  assert.equal(freshWithGap.unread, 5, 'a genuine gap with no local copy to compare against trusts the incoming count');
});
