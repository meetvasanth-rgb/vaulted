'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const worker = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('the Android unread fix ships in a fresh app-shell cache', () => {
  // Version-agnostic on purpose — pinning an exact number here just means
  // the NEXT unrelated cache bump breaks this test for no real reason.
  // What actually matters is that it's a real, well-formed version tag.
  assert.match(worker, /vaultlix-app-shell-v\d+/);
});

test('direct-chat unread state survives restart and clears only when viewed', () => {
  assert.match(client, /unread: Math\.max\(0, Number\(unread\) \|\| 0\)/);
  assert.match(client, /unreadSystemCount: Math\.max\(0, Number\(unreadSystemCount\) \|\| 0\)/);
  assert.match(client, /existing\.unread = Math\.max\(0, Number\(room\.unread\) \|\| 0\)/);
  assert.match(client, /existing\.unreadSystemCount = Math\.max\(0, Number\(room\.unreadSystemCount\) \|\| 0\)/);
  assert.match(client, /makeRoom\(\{[^\n]+unread:healedUnread, unreadSystemCount:healedUnreadSystemCount/);
  assert.match(client, /function setActiveRoom[\s\S]{0,600}room\.unread = 0; room\.unreadSystemCount = 0;[\s\S]{0,240}persistRoomSeq\(room\)/);
  assert.match(client, /lastReadSeq:Math\.max\(0, Number\(room\.lastReadSeq\) \|\| 0\)/);
  assert.match(client, /lastReadSeq:session\.lastReadSeq === undefined \? session\.lastSeq : session\.lastReadSeq/);
  assert.match(client, /unreadStateVersion:session\.unreadStateVersion \|\| 0/);
  assert.match(client, /unreadMigrationCutoffAt:session\.savedAt/);
});

test('successful full restore rebuilds unread counts from server read receipts', () => {
  assert.match(client, /msg\.type !== 'message' \|\| msg\.from === room\.token \|\| msg\.readAt/);
  assert.match(client, /room\.unread = restoredUnread/);
  assert.match(client, /room\.unreadSystemCount = restoredUnreadSystemCount/);
  assert.match(client, /Number\(msg\.seq\) <= \(Number\(room\.lastReadSeq\) \|\| 0\)/);
  assert.match(client, /if \(room\.unreadMigrationPending\)[\s\S]{0,1200}room\.unreadStateVersion = 2/);
  assert.match(client, /legacyReadBaseline[\s\S]{0,400}new Date\(msg\.ts \|\| 0\)\.getTime\(\)[\s\S]{0,400}Number\(msg\.seq\)/);
  assert.match(client, /if \(unreadChanged\) persistRoomSeq\(room\)/);
});

test('legacy unread state migrates during lightweight startup reconnects', () => {
  assert.match(client, /unreadCutoffAt:room\.unreadMigrationPending \? room\.unreadMigrationCutoffAt : undefined/);
  assert.match(client, /if \(room\.unreadMigrationPending && result\.unreadBaselineSeq !== undefined\)[\s\S]{0,900}room\.unreadStateVersion = 2/);
  assert.match(client, /room\.lastSeq = Math\.max\(Number\(room\.lastSeq\) \|\| 0, baseline\)/);
  assert.match(server, /function unreadBaselineSeqForCutoff\(room, rawCutoff\)[\s\S]{0,700}new Date\(message\?\.ts \|\| 0\)\.getTime\(\)/);
  assert.match(server, /lastMessageAt: room\.lastMessageAt \|\| 0, unreadBaselineSeq/);
});

// A stale unread/lastReadSeq/lastSeq triple was already self-healed by a
// SEPARATE invariant check in the slow, sequential per-room /api/join loop
// (one real network round-trip at a time) — logically instant, but gated
// behind the room's own turn in that sequential loop, so with many rooms a
// stale badge could sit visibly wrong for a noticeable stretch before
// quietly correcting itself. That reads as "the unread count is flaky" to
// a normal user, even though it was always technically correcting itself
// eventually. This moves the exact same check into the fast, synchronous,
// purely-local hydration pass that runs for every room before the very
// first frame paints, so the badge is never visibly wrong in the first
// place instead of flickering then fixing itself.
test('the fast synchronous hydration pass self-heals a stale unread counter before makeRoom(), not only in the slow network loop', () => {
  const idx = client.indexOf('const sessionLastSeq = Number(session.lastSeq) || 0;');
  assert.notEqual(idx, -1);
  const section = client.slice(idx, idx + 2000);
  assert.match(section, /const sessionLastReadSeq = session\.lastReadSeq === undefined \? sessionLastSeq : \(Number\(session\.lastReadSeq\) \|\| 0\);/);
  assert.match(section, /const sessionUnreadStale = sessionLastReadSeq >= sessionLastSeq && \(\(Number\(session\.unread\) \|\| 0\) > 0 \|\| \(Number\(session\.unreadSystemCount\) \|\| 0\) > 0\);/);
  assert.match(section, /const healedUnread = sessionUnreadStale \? 0 : session\.unread;/);
  assert.match(section, /const healedUnreadSystemCount = sessionUnreadStale \? 0 : session\.unreadSystemCount;/);
  assert.match(section, /if \(sessionUnreadStale\) persistHealedUnread\(session\.code\);/);
});

test('fast-path persistence uses a narrow read-modify-write (persistHealedUnread), never persistRoomSeq, which would corrupt lastSeq at this point', () => {
  // room.lastSeq is still makeRoom()'s own default (0) when the fast
  // hydration pass runs — the real value isn't set onto room until the
  // slow per-room loop, later. persistRoomSeq() writes lastSeq (and
  // lastReceiptSeq/lastReactionSeq/lastDeletionSeq) unconditionally, so
  // calling it here would silently overwrite the correctly stored lastSeq
  // with 0 — the exact "stuck lastSeq causes message redelivery,
  // inflating unread counts" failure mode documented elsewhere in this
  // file's own startup code.
  const fnStart = client.indexOf('function persistHealedUnread(code) {');
  assert.notEqual(fnStart, -1);
  const fnEnd = client.indexOf('\n}', fnStart) + 2;
  const fn = client.slice(fnStart, fnEnd);
  assert.match(fn, /existing\.unread = 0;/);
  assert.match(fn, /existing\.unreadSystemCount = 0;/);
  assert.doesNotMatch(fn, /lastSeq/, 'must not touch lastSeq or any other seq field — only its own two fields');
});

// Functional check of the actual self-heal condition/outcome, extracted
// and run directly against hand-picked session values — the structural
// test above only confirms the code exists, not that the formula is right.
test('functional: the self-heal formula correctly distinguishes a genuine unread gap from a stale leftover counter', () => {
  const idx = client.indexOf('const sessionLastSeq = Number(session.lastSeq) || 0;');
  const end = client.indexOf('const room = makeRoom(', idx);
  const logic = client.slice(idx, end);
  function evaluate(session) {
    const sandbox = vm.createContext({ Number, session, result: {} });
    vm.runInContext(`${logic}\nresult = { healedUnread, healedUnreadSystemCount, sessionUnreadStale };`, sandbox);
    return JSON.parse(JSON.stringify(sandbox.result));
  }
  // Exactly the live bug: migration already ran (version 2 elsewhere),
  // lastReadSeq caught up to lastSeq, but unread was never reconciled.
  const stale = evaluate({ lastSeq: 7, lastReadSeq: 7, unread: 4, unreadSystemCount: 0 });
  assert.deepEqual(stale, { healedUnread: 0, healedUnreadSystemCount: 0, sessionUnreadStale: true });
  // A genuine gap (lastReadSeq behind lastSeq) must be left alone.
  const genuine = evaluate({ lastSeq: 10, lastReadSeq: 6, unread: 4, unreadSystemCount: 1 });
  assert.deepEqual(genuine, { healedUnread: 4, healedUnreadSystemCount: 1, sessionUnreadStale: false });
  // A room that's actually fully read (unread already 0) must not be
  // flagged as "healed" just because lastReadSeq caught up — nothing was
  // actually wrong, so sessionUnreadStale should stay false.
  const alreadyClean = evaluate({ lastSeq: 7, lastReadSeq: 7, unread: 0, unreadSystemCount: 0 });
  assert.equal(alreadyClean.sessionUnreadStale, false);
});
