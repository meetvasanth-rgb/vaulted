'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function functionSource(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const end = client.indexOf('\nfunction ', start + 1);
  assert.notEqual(end, -1, `${name} should have a following function to bound it`);
  return client.slice(start, end);
}

test('lastSeq advances for every server message before the seenMsgIds dedupe skip, in both doPoll and applyRestoredHistory', () => {
  // A message already in seenMsgIds (e.g. a call-event this device posted
  // itself via addCallSysMsg, or anything else pre-seeded outside the
  // normal poll path) must still push room.lastSeq forward. Skipping that
  // update before the dedupe `continue` leaves lastSeq permanently stuck
  // under that message's seq whenever it's the room's most recent activity
  // — seenMsgIds resets on every fresh launch but the stuck lastSeq
  // persists, so the server redelivers the same old message as if it were
  // new on every subsequent app open, inflating unread counts for
  // something the user already dealt with.
  for (const name of ['doPoll', 'applyRestoredHistory']) {
    const body = functionSource(name);
    const lastSeqIndex = body.indexOf('room.lastSeq = msg.seq');
    const seenSkipIndex = body.indexOf('if (room.seenMsgIds.has(msg.id)) continue;');
    assert.notEqual(lastSeqIndex, -1, `${name} should advance room.lastSeq`);
    assert.notEqual(seenSkipIndex, -1, `${name} should dedupe via seenMsgIds`);
    assert.ok(lastSeqIndex < seenSkipIndex,
      `${name}: room.lastSeq advancement must run BEFORE the seenMsgIds dedupe skip`);
    // Exactly one advancement site per function now (the trailing duplicate
    // after the message-type branch was removed from doPoll).
    assert.equal((body.match(/room\.lastSeq = msg\.seq/g) || []).length, 1, `${name} should advance lastSeq exactly once per message`);
  }
});

// Isolated simulation of the dedupe/high-water-mark pattern itself — not the
// full doPoll/applyRestoredHistory (too many external dependencies to run
// directly) — proving the bug class and that reordering fixes it.
function simulateIncrementalCatchup(room, serverMessages, { advanceBeforeSkip }) {
  let unreadDeliveries = 0;
  for (const msg of serverMessages) {
    if (advanceBeforeSkip) {
      if (msg.seq > room.lastSeq) room.lastSeq = msg.seq;
      if (room.seenMsgIds.has(msg.id)) continue;
      room.seenMsgIds.add(msg.id);
    } else {
      if (room.seenMsgIds.has(msg.id)) continue;
      room.seenMsgIds.add(msg.id);
      if (msg.seq > room.lastSeq) room.lastSeq = msg.seq;
    }
    unreadDeliveries++; // a message that reaches here counts as "newly delivered"
  }
  return unreadDeliveries;
}

// Mirrors /api/poll's own filter (server/index.js: `msg.seq <= clientLastSeq`
// is excluded) — the server only omits a message once the client's OWN
// reported lastSeq has actually caught up past it.
function serverPoll(allMessages, clientLastSeq) {
  return allMessages.filter(msg => msg.seq > clientLastSeq);
}

test('buggy ordering lets a locally-seeded record get redelivered as unread after a fresh launch; fixed ordering does not', () => {
  const allMessages = [{ id: 'call-event-XYZ', seq: 41 }];

  // Session 1 (buggy ordering): the call-event was created locally by
  // addCallSysMsg and pre-seeded into seenMsgIds (simulated here directly,
  // since that path never advances lastSeq either way), then the server's
  // own echo of it arrives through the catch-up loop.
  let room = { lastSeq: 40, seenMsgIds: new Set(['call-event-XYZ']) };
  let delivered = simulateIncrementalCatchup(room, serverPoll(allMessages, room.lastSeq), { advanceBeforeSkip: false });
  assert.equal(delivered, 0, 'the same-session echo is correctly deduped either way');
  assert.equal(room.lastSeq, 40, 'BUG: lastSeq never advances past the deduped message');

  // Fresh launch: seenMsgIds resets, lastSeq (persisted) is still stuck at
  // 40, so the server — which only trusts the client's own reported
  // lastSeq — includes the call event again.
  room = { lastSeq: room.lastSeq, seenMsgIds: new Set() };
  delivered = simulateIncrementalCatchup(room, serverPoll(allMessages, room.lastSeq), { advanceBeforeSkip: false });
  assert.equal(delivered, 1, 'BUG: the already-handled call event is redelivered as if new');

  // Same scenario with the fix: lastSeq advances before the dedupe skip.
  room = { lastSeq: 40, seenMsgIds: new Set(['call-event-XYZ']) };
  simulateIncrementalCatchup(room, serverPoll(allMessages, room.lastSeq), { advanceBeforeSkip: true });
  assert.equal(room.lastSeq, 41, 'FIXED: lastSeq advances even for a deduped message');

  room = { lastSeq: room.lastSeq, seenMsgIds: new Set() };
  delivered = simulateIncrementalCatchup(room, serverPoll(allMessages, room.lastSeq), { advanceBeforeSkip: true });
  assert.equal(delivered, 0, 'FIXED: the server never returns it again once lastSeq is genuinely past it');
});
