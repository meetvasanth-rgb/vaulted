'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TERMINATED_INVITE_TTL_MS,
  markInviteTerminated,
  isInviteTerminated,
} = require('./call-invite-state');

test('a late retry of a declined invitation stays terminated', () => {
  const room = {};
  markInviteTerminated(room, 'invite-1234567890', 1_000);

  assert.equal(isInviteTerminated(room, 'invite-1234567890', 4_000), true);
  assert.equal(isInviteTerminated(room, 'different-123456', 4_000), false);
});

test('the tombstone expires after the ringing retry window', () => {
  const room = {};
  markInviteTerminated(room, 'invite-1234567890', 1_000);

  assert.equal(
    isInviteTerminated(room, 'invite-1234567890', 1_000 + TERMINATED_INVITE_TTL_MS + 1),
    false
  );
  assert.equal(room.terminatedInviteId, null);
});
