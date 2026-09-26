'use strict';

// The reply to POST /api/history: one page of older messages for a conversation
// member. Rows arrive oldest-first from PostgreSQL and were requested with one
// extra row; getting that extra one means there is still more to load.
// Messages are shaped like the ones /api/poll returns, so the client can restore
// them through the same code path.

function buildHistoryPage({ room, token, rows, limit, sameToken, reactionsForViewer }) {
  const list = Array.isArray(rows) ? rows : [];
  const hasMore = list.length > limit;
  const page = hasMore ? list.slice(list.length - limit) : list;
  const messages = [];
  for (const durable of page) {
    // A sender who is no longer a member of the conversation cannot be attributed.
    if (!room.members.has(durable.senderTokenHash)) continue;
    const from = sameToken(durable.senderTokenHash, token) ? token : durable.senderTokenHash;
    messages.push({
      seq:durable.seq,
      id:durable.id,
      type:'message',
      from,
      name:room.members.get(durable.senderTokenHash)?.name || null,
      content:durable.content,
      viewOnce:false,
      ts:durable.ts,
      expiresAt:null,
      deleteTimerSeconds:0,
      deliveredAt:durable.deliveredAt ?? null,
      readAt:durable.readAt ?? null,
      reactions:reactionsForViewer(durable.reactions, token),
    });
  }
  return { messages, hasMore };
}

module.exports = { buildHistoryPage };
