'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '../client/groups.js'), 'utf8');

function extractFromClient(name) {
  let start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist in client/index.html`);
  if (client.slice(Math.max(0, start - 6), start) === 'async ') start -= 6;
  let i = client.indexOf('(', start);
  let parenDepth = 0;
  for (; i < client.length; i++) {
    if (client[i] === '(') parenDepth++;
    else if (client[i] === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
  }
  i = client.indexOf('{', i);
  let braceDepth = 0;
  for (; i < client.length; i++) {
    if (client[i] === '{') braceDepth++;
    else if (client[i] === '}') { braceDepth--; if (braceDepth === 0) { i++; break; } }
  }
  return client.slice(start, i);
}

// ── Bug: tapping a group-message notification didn't navigate into the group ──

test('the server never sees a stripped group push: groupId/privateGroup travel through both APNs and FCM payload builders', () => {
  assert.match(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8'),
    /privateGroup: !!parsed\.privateGroup,\s*\n\s*groupId: parsed\.privateGroup \? String\(parsed\.groupId \|\| ''\) : '',/);
  assert.match(fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8'),
    /privateGroup: parsed\.privateGroup \? 'true' : 'false',\s*\n\s*groupId: parsed\.privateGroup \? String\(parsed\.groupId \|\| ''\) : '',/);
});

test('a private-group FCM push is data-only (same reliability fix already applied to regular messages)', () => {
  const server = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');
  assert.match(server, /if \(!parsed\.isCall && !parsed\.isCallEnd && !parsed\.msgId && !parsed\.groupId\) \{/);
});

test('pushNotificationActionPerformed routes a group-message notification to openPrivateGroup, with a deferred fallback for the not-yet-loaded race', () => {
  assert.match(client, /if \(notification\?\.data\?\.privateGroup === true \|\| notification\?\.data\?\.privateGroup === 'true'\) \{/);
  assert.match(client, /if \(privateGroups\.has\(groupId\)\) refreshPrivateGroups\(\)\.then\(\(\) => openPrivateGroup\(groupId\)\)\.catch\(\(\) => \{\}\);/);
  assert.match(client, /else pendingNotificationGroupId = groupId;/);
});

test('pendingNotificationGroupId is declared and consumed at startup, alongside the URL-param (?group=) path', () => {
  assert.match(client, /let pendingNotificationGroupId = null;/);
  assert.match(client, /const notifyGroupId = \(startupPrivateGroupId && privateGroups\.has\(startupPrivateGroupId\)\) \? startupPrivateGroupId\s*\n\s*: \(pendingNotificationGroupId && privateGroups\.has\(pendingNotificationGroupId\)\) \? pendingNotificationGroupId\s*\n\s*: null;/);
  assert.match(client, /if \(notifyGroupId\) \{\s*\n\s*history\.replaceState\(null, '', '\/'\);\s*\n\s*await openPrivateGroup\(notifyGroupId\);/);
});

test('Android builds its own notification for a group message (deep-linking to ?group=), instead of falling through to the default handler', () => {
  const android = fs.readFileSync(path.join(__dirname, '../mobile/android/app/src/main/java/com/vaultlix/app/VaultlixMessagingService.java'), 'utf8');
  assert.match(android, /String groupId = safe\(data\.get\("groupId"\)\);/);
  assert.match(android, /if \(!groupId\.isEmpty\(\)\) \{\s*\n\s*showGroupMessageNotification\(data\);\s*\n\s*return;/);
  assert.match(android, /private void showGroupMessageNotification\(Map<String, String> data\)/);
  assert.match(android, /\.appendQueryParameter\("group", groupId\)/);
  // Must use a distinct notification-id namespace from room messages, so a
  // group notification can never silently replace/be replaced by a room one.
  assert.match(android, /\("group:" \+ groupId\)\.hashCode\(\)/);
});

// ── Bug: no unread badge for group conversations ──

test('mergePrivateGroupMessages returns the actual fresh records (not just a count), so callers can decide what counts as unread', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(groups.slice(groups.indexOf('function mergePrivateGroupMessages'), groups.indexOf('\nfunction privateGroupOldestCreatedAt')), context);

  const group = { messages: [{ id: 'a', createdAt: 1 }] };
  const fresh = context.mergePrivateGroupMessages(group, [
    { id: 'a', createdAt: 1 }, // already known — must be excluded
    { id: 'b', createdAt: 2, senderId: 'peer' },
    { id: 'c', createdAt: 3, senderId: 'me' },
  ]);
  // JSON round-trip: fresh/group.messages are vm-realm arrays, and
  // node:assert's deepEqual can spuriously fail comparing them directly
  // against a main-realm array literal even when the content matches.
  assert.deepEqual(JSON.parse(JSON.stringify(fresh.map(m => m.id))), ['b', 'c']);
  assert.deepEqual(JSON.parse(JSON.stringify(group.messages.map(m => m.id))), ['a', 'b', 'c']);
});

test('pollPrivateGroup increments group.unread from poll catch-up (not just the live socket), excluding the open group and this account\'s own messages', () => {
  assert.match(groups,
    /if \(changed && group\.id !== activePrivateGroupId\) \{\s*\n\s*const newUnread = fresh\.filter\(message => message\.senderId !== state\.accountId\)\.length;\s*\n\s*if \(newUnread > 0\) \{ group\.unread = \(group\.unread \|\| 0\) \+ newUnread; renderVaultList\(\); \}/);
});
