const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'client/admin.html'), 'utf8');
const js = fs.readFileSync(path.join(root, 'client/admin.js'), 'utf8');

test('admin dashboard represents identities and conversations instead of vault architecture', () => {
  assert.match(html, /Registered identities/);
  assert.match(html, /Active conversations/);
  assert.match(html, /Vaultlix identities/);
  assert.doesNotMatch(html, />Active vaults</);
  assert.doesNotMatch(html, />Vault activity</);
  assert.match(html, /Notification readiness/);
  assert.match(html, /Live conversation load/);
  assert.match(html, /Encrypted realtime buffer/);
  assert.match(html, /id="health-pill">Checking/);
  assert.match(js, /s\.system\.healthStatus/);
  assert.match(server, /healthStatus/);
  assert.match(server, /PostgreSQL connected/);
});

test('admin identity directory returns useful metadata without account secrets', () => {
  const route = server.slice(server.indexOf("if ((path === '/api/admin/stats'"), server.indexOf("resErr(res,'Not found.'"));
  assert.match(route, /displayName: account\.displayName/);
  assert.match(route, /privateNumber: account\.privateNumber/);
  assert.match(route, /activeDevices:/);
  assert.match(route, /notificationDevices:/);
  assert.match(route, /pendingRequests:/);
  assert.doesNotMatch(route, /passwordWrap: account/);
  assert.doesNotMatch(route, /recoveryWrap: account/);
  assert.doesNotMatch(route, /authVerifier: account/);
  assert.doesNotMatch(route, /bundle: account/);
  assert.match(js, /function renderIdentities/);
  // Sorted by genuine recent activity (lastActiveAt), not updatedAt — which
  // only moves on account-record changes and ranked a continuously active
  // user below people who'd merely edited their profile recently.
  assert.match(route, /\.sort\(\(a, b\) => \(b\.lastActiveAt \|\| 0\) - \(a\.lastActiveAt \|\| 0\)\)/);
});

// "Updated" (account.updatedAt) only moves on password/recovery/profile
// changes and account-bundle syncs — not on ordinary message activity, so
// it went stale for a continuously active user whose client mostly talks
// over the inbox WebSocket. lastActiveAt is the field that actually tracks
// activity (see the inbox socket's pong handler, which now refreshes it on
// every heartbeat) — this is a separate "Last Online" column rather than
// replacing "Updated", so an admin can still see both account-record
// changes and genuine recent activity.
test('the identity table has a separate Last Online column sourced from lastActiveAt, alongside Updated', () => {
  assert.match(html, /<th>Updated<\/th><th>Last Online<\/th>/);
  const row = js.slice(js.indexOf('function renderIdentities'), js.indexOf('function setGauge'));
  const updatedIndex = row.indexOf('identity.updatedAt');
  const lastOnlineIndex = row.indexOf('identity.lastActiveAt');
  assert.notEqual(updatedIndex, -1);
  assert.notEqual(lastOnlineIndex, -1);
  assert.ok(lastOnlineIndex > updatedIndex, 'Last Online column comes after Updated, matching the header order');
  // Both empty-state and loading-state colspans must match the real <th> count.
  assert.match(html, /<td colspan="8" class="empty-row">Loading identities…<\/td>/);
  assert.match(js, /<tr><td colspan="8" class="empty-row">No registered identities yet\.<\/td><\/tr>/);
});
