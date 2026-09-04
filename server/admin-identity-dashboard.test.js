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
});

test('admin identity directory returns useful metadata without account secrets', () => {
  const route = server.slice(server.indexOf("if (path === '/api/admin/stats'"), server.indexOf("resErr(res,'Not found.'"));
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
});
