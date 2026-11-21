'use strict';

// Local caches intentionally omit disappearing content. A sequence cursor
// therefore cannot establish that every earlier send/receive is cached.
// Re-send only a bounded retained tail, alongside every new delta message.
function repairPollRestoreWindow({ delta, retained, limit, isOwn, now = Date.now() }) {
  const eligible = message => message && !message.deleted
    && !(Number(message.expiresAt) > 0 && Number(message.expiresAt) <= now)
    && !(message.type === 'system' && isOwn(message));
  const recent = (retained || []).filter(eligible)
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .slice(-Math.max(1, Math.min(100, Number(limit) || 50)));
  const byId = new Map();
  for (const message of [...(delta || []), ...recent]) {
    if (eligible(message)) byId.set(message.id, message);
  }
  return [...byId.values()].sort((a, b) => Number(a.seq) - Number(b.seq));
}

module.exports = { repairPollRestoreWindow };
