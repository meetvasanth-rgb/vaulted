'use strict';

// Which group messages one member is sent. A member never sees what was said
// before they joined (`joinedAt`).
//
//   after   — only newer than this (the normal poll)
//   before  — only older than this (paging back through history)
//   limit   — at most this many, the newest of the matching ones
//   oldest  — the oldest message the caller already holds; lets a normal poll
//             learn whether anything older is still on the server
//
// hasOlder says whether anything visible to this member lies before the
// oldest message returned (or held), so the app knows whether to offer
// "Load earlier messages".
const GROUP_PAGE_DEFAULT = 200;
const GROUP_PAGE_MAX = 200;

function selectGroupMessages(messages, joinedAt, { after = 0, before = 0, limit = GROUP_PAGE_DEFAULT, oldest = 0 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const from = Number.isFinite(Number(joinedAt)) ? Number(joinedAt) : 0;
  const cursor = Number.isFinite(Number(after)) ? Number(after) : 0;
  const upper = Number(before) > 0 ? Number(before) : 0;
  const count = Math.min(GROUP_PAGE_MAX, Math.max(1, Math.floor(Number(limit)) || GROUP_PAGE_DEFAULT));
  const selected = list
    .filter(message => message.createdAt > cursor && message.createdAt >= from && (!upper || message.createdAt < upper))
    .slice(-count);
  const held = Number(oldest) > 0 ? Number(oldest) : Infinity;
  const floor = upper
    ? (selected[0]?.createdAt ?? upper)
    : Math.min(held, selected[0]?.createdAt ?? Infinity);
  const hasOlder = floor !== Infinity && list.some(message => message.createdAt < floor && message.createdAt >= from);
  return { selected, hasOlder };
}

module.exports = { selectGroupMessages, GROUP_PAGE_DEFAULT, GROUP_PAGE_MAX };
