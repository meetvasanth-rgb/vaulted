'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const androidMessagingService = fs.readFileSync(
  path.join(__dirname, '../mobile/android/app/src/main/java/com/vaultlix/app/VaultlixMessagingService.java'), 'utf8');

// Bug: right after any server restart (or any in-memory cache eviction),
// the `rooms` Map cache is empty (bootstrap() calls rooms.clear() whenever
// PostgreSQL is the authoritative store), while the conversation itself is
// still fully intact in PostgreSQL. Every other conversation route already
// rehydrates on demand via ensureConversationLoaded(); /api/poll and
// /api/history instead did a bare rooms.get() and reported roomGone:true
// for a perfectly live conversation the moment it was the first request to
// touch it post-restart. The client trusts roomGone and PERMANENTLY wipes
// the room locally (removeRoomFromState) — this is the "a contact vanished
// after a brief Railway outage, but they could still call me" bug (the
// server-side room/membership itself was never touched, hence the call
// still worked).
test('/api/poll rehydrates from PostgreSQL via ensureConversationLoaded, not a bare rooms.get()', () => {
  const start = server.indexOf("if (path==='/api/poll' && method==='POST')");
  assert.notEqual(start, -1);
  const end = server.indexOf("if (path==='/api/history'", start);
  const section = server.slice(start, end);
  assert.match(section, /const room = await ensureConversationLoaded\(roomCode\);/);
  assert.doesNotMatch(section, /const room = rooms\.get\(roomCode\);/);
});

test('/api/history rehydrates from PostgreSQL via ensureConversationLoaded, not a bare rooms.get()', () => {
  const start = server.indexOf("if (path==='/api/history' && method==='POST')");
  assert.notEqual(start, -1);
  const section = server.slice(start, start + 800);
  assert.match(section, /const room = await ensureConversationLoaded\(d\.code\);/);
  assert.doesNotMatch(section, /const room = rooms\.get\(d\.code\);/);
});

// Same class of bug existed in every other conversation route in the giant
// async api() handler (join, send, react, delete-message, typing, mark
// delivered/read, clear-chat, close, leave, revoke-link, attachment
// prepare/download/content, push-subscribe variants, turn-credentials,
// set-timer, make-persistent, report/block) — all fixed identically.
test('no bare rooms.get(d.code)/rooms.get(roomCode) conversation lookups remain anywhere in the request handler', () => {
  const bareLookups = server.match(/^\s*const room2? = rooms\.get\((?:d\.code|roomCode)\);\s*$/gm) || [];
  assert.deepEqual(bareLookups, []);
});

// ensureConversationLoaded() itself, and the WS connection-open handler
// that already called it before this fix, must be untouched — they are the
// implementation, not a call site to convert.
test('ensureConversationLoaded implementation itself still does the real cache-then-PostgreSQL lookup', () => {
  const start = server.indexOf('async function ensureConversationLoaded(roomCode');
  assert.notEqual(start, -1);
  const section = server.slice(start, start + 400);
  assert.match(section, /rooms\.has\(roomCode\)/);
  assert.match(section, /loadConversationFromPostgres\(roomCode, client\)/);
});

// Defense in depth beyond the server fix above: doPoll() is event-driven
// (fires on inbox "changed" pushes, not a fixed interval), so a single
// transient roomGone must not be trusted enough to trigger
// removeRoomFromState's full, permanent, unrecoverable local wipe
// (localStorage blob, keypair, history). Require a second roomGone,
// reachable only by re-polling, before actually deleting anything.
test('doPoll requires two consecutive roomGone responses before wiping the room locally', () => {
  const start = client.indexOf('async function doPoll(room) {');
  assert.notEqual(start, -1);
  const goneStart = client.indexOf('if (data.roomGone) {', start);
  assert.notEqual(goneStart, -1);
  const goneEnd = client.indexOf('renderRoomTabs();\n      return;\n    }', goneStart);
  const goneBlock = client.slice(goneStart, goneEnd);
  assert.match(goneBlock, /room\.roomGoneStrikes = \(room\.roomGoneStrikes \|\| 0\) \+ 1;/);
  assert.match(goneBlock, /if \(room\.roomGoneStrikes < 2\) \{/);
  assert.match(goneBlock, /setTimeout\(\(\) => doPoll\(room\), 4000\);/);
  // The actual permanent wipe must be textually AFTER the early-return guard.
  const strikeCheckIdx = goneBlock.indexOf('room.roomGoneStrikes < 2');
  const wipeIdx = goneBlock.indexOf('removeRoomFromState(room.code);', strikeCheckIdx);
  assert.ok(strikeCheckIdx > 0 && wipeIdx > strikeCheckIdx);
});

test('doPoll resets the roomGone strike counter on any successful (non-gone) response', () => {
  const start = client.indexOf('async function doPoll(room) {');
  const goneEnd = client.indexOf('renderRoomTabs();\n      return;\n    }', start);
  const afterGoneBlock = client.slice(goneEnd, goneEnd + 200);
  assert.match(afterGoneBlock, /room\.roomGoneStrikes = 0;/);
});

// Bug: the Calls tab aggregates from room.messages, which the client only
// ever restores the newest 100 entries of (server cap + client page size,
// both hardcoded at 100) with no pagination wired to this tab — a call
// buried behind >100 newer chat messages was permanently unreachable from
// Calls, regardless of the room's own history being fully restored,
// appearing as calls "randomly" missing depending on each contact's chat
// volume. Reuses the same loadEarlierMessages/historyOldestSeq machinery
// chat's own "Load earlier messages" button already uses, across every
// room with more available at once.
test('renderCallHistoryList offers a "Load earlier calls" button that pages every eligible room', () => {
  const start = client.indexOf('function renderCallHistoryList(body) {');
  assert.notEqual(start, -1);
  const end = client.indexOf('\nfunction ', start + 1);
  const source = client.slice(start, end);
  assert.match(source, /room\.historyLoaded && !room\.historyEarlierExhausted && Number\(room\.historyOldestSeq\) > 1/);
  assert.match(source, /loadEarlierMessages\(room\)\.catch/);
  assert.match(source, /load-earlier-calls-btn/);
});

// Bug: on a cold PushKit-triggered launch (privacy-preserving payloads
// carry no room code), CallKit's native nativeConnected/audioActivated
// events — the ONLY two actions that ever call
// presentNativeCallRoom()/renderCallOverlay() to actually show the in-app
// call screen — could fire before `rooms` was populated. The old queue
// stored only the bare action STRING and was replayed for exactly three
// hardcoded values ('answer'/'answerWhenActive'/'declineOrEnd'); the other
// two were silently dropped on replay, leaving the app on whatever screen
// it booted to while CallKit's native audio was already live — "answered
// an iOS-to-iOS call but the call screen never appears."
test('the pending native call action queue stores the full event detail, not just the bare action string', () => {
  const start = client.indexOf('async function handleNativeCallAction(detail) {');
  assert.notEqual(start, -1);
  const section = client.slice(start, start + 3500);
  assert.match(section, /pendingNativeCallActions\.set\(nativeRoomCode, detail\);/);
  assert.match(section, /pendingNativeUnscopedAction = detail;/);
  assert.doesNotMatch(section, /pendingNativeCallActions\.set\(nativeRoomCode, detail\.action\);/);
});

test('replaying a queued native call action can now present the call screen for nativeConnected/audioActivated, not just answer/decline', () => {
  const idx = client.indexOf("const pendingDetail = pendingNativeCallActions.get(room.code) || pendingNativeUnscopedAction;");
  assert.notEqual(idx, -1);
  const section = client.slice(idx, idx + 1100);
  assert.match(section, /nativeAction === 'answer' \|\| nativeAction === 'answerWhenActive'/);
  assert.match(section, /nativeAction === 'declineOrEnd'/);
  assert.match(section, /nativeAction === 'nativeConnected' \|\| nativeAction === 'audioActivated'/);
  assert.match(section, /await handleNativeCallAction\(pendingDetail\);/);
});

test('every pendingNativeCallActions.set/pendingNativeUnscopedAction assignment uses the same object shape', () => {
  const setCalls = client.match(/pendingNativeCallActions\.set\([^,]+,\s*([^)]+)\)/g) || [];
  assert.ok(setCalls.length >= 3);
  for (const call of setCalls) {
    // Every call site must pass an object ({action:'...'} or the raw
    // detail object) — never a bare quoted string, which is exactly the
    // shape mismatch that broke the replay site above.
    assert.doesNotMatch(call, /,\s*'[a-zA-Z]+'\)/);
  }
});

// Bug: Android re-derived "was this call missed" from
// "true".equalsIgnoreCase(missedCall) OR "unanswered".equals(callOutcome),
// second-guessing the server's own authoritative isMissedCall computation
// (server/index.js: wasStillRinging && callOutcome === 'unanswered', the
// only place that actually knows whether call-accept was ever processed).
// callOutcome alone is not a safe secondary signal: a caller-side 30s ring
// timeout can still send terminalReason:'unanswered' even after the callee
// genuinely answered (e.g. the answer signal was delayed reaching the
// caller), which made this OR mislabel a normally-completed call as missed
// and fire a spurious "Missed call" notification for it every time.
test('Android trusts only the server-authoritative missedCall flag, not a callOutcome-based OR', () => {
  const start = androidMessagingService.indexOf('if ("true".equalsIgnoreCase(data.get("isCallEnd")))');
  assert.notEqual(start, -1);
  const section = androidMessagingService.slice(start, start + 1400);
  assert.match(section, /boolean missedCall = "true"\.equalsIgnoreCase\(data\.get\("missedCall"\)\);/);
  assert.doesNotMatch(section, /missedCall\s*=\s*"true"\.equalsIgnoreCase\(data\.get\("missedCall"\)\)\s*\n\s*\|\|/);
});

// The server's own authoritative computation this Android fix now trusts
// alone — regression guard so a future edit can't silently reintroduce the
// same class of bug server-side.
test('server computes isMissedCall from wasStillRinging, not from callOutcome alone', () => {
  const idx = server.indexOf("const isMissedCall = wasStillRinging && callOutcome === 'unanswered';");
  assert.notEqual(idx, -1);
});
