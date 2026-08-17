'use strict';

// Callers intentionally retry an invitation every three seconds while the
// peer is waking. A terminal action can race one of those already-queued
// retries, so retain the invitation nonce slightly longer than the 30-second
// ring window and reject only retries belonging to that exact call.
const TERMINATED_INVITE_TTL_MS = 45 * 1000;

function markInviteTerminated(room, inviteId, now = Date.now()) {
  if (!room || typeof inviteId !== 'string' || !inviteId) return;
  room.terminatedInviteId = inviteId;
  room.terminatedInviteUntil = now + TERMINATED_INVITE_TTL_MS;
}

function isInviteTerminated(room, inviteId, now = Date.now()) {
  if (!room || typeof inviteId !== 'string' || !inviteId) return false;
  if (!(room.terminatedInviteUntil > now)) {
    room.terminatedInviteId = null;
    room.terminatedInviteUntil = 0;
    return false;
  }
  return room.terminatedInviteId === inviteId;
}

module.exports = { TERMINATED_INVITE_TTL_MS, markInviteTerminated, isInviteTerminated };
