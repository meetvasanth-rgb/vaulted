const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('inbox bottom bar exposes compact icon-only add, chats and calls actions', () => {
  const bar = client.match(/<div class="vault-list-actions">[\s\S]*?<\/div>\s*<\/div>\s*<!-- CLOSED -->/)?.[0] || '';
  assert.match(bar, /onclick="openNewConnection\(\)"[^>]*aria-label="Add your friend"[^>]*data-tooltip="Add your friend"/);
  assert.match(bar, /id="vault-nav-chats"[\s\S]*setVaultListMode\('chats'\)/);
  assert.match(bar, /id="vault-nav-calls"[\s\S]*setVaultListMode\('calls'\)/);
  assert.doesNotMatch(bar, /<span[^>]*>\s*(?:Add your friend|Chats|Calls)\s*<\/span>/);
  assert.match(client, /\.vault-list-action\{width:46px;height:44px/);
  assert.match(client, /\.vault-list-action\[data-tooltip\]:hover::after/);
});

test('calls view is derived only from decrypted encrypted-conversation call records', () => {
  assert.match(client, /function callHistoryEntries\(\)[\s\S]*for \(const room of rooms\.values\(\)\)[\s\S]*uniqueVisibleConversationRecords\(room\.messages\)[\s\S]*callHistoryFamily\(rec\)/);
  assert.match(client, /function renderCallHistoryList\(body\)[\s\S]*callHistoryEntries\(\)[\s\S]*openVaultListRoom\(el\.dataset\.room\)/);
  assert.doesNotMatch(client, /function renderCallHistoryList\(body\)[\s\S]{0,1200}(?:api\(|fetch\()/);
});

test('status thumbnails stay compact and live statuses mark matching inbox contacts', () => {
  assert.match(client, /\.status-ring\{display:block;width:56px;height:68px[^}]*border-radius:19px/);
  assert.match(client, /\.status-add\{position:absolute;right:2px;bottom:2px;width:19px;height:19px/);
  assert.match(client, /const liveStatusAuthors = new Set\(statusFeed[\s\S]*normalizePrivateNumber\(item\.authorPrivateNumber\)/);
  assert.match(client, /hasLiveStatus = liveStatusAuthors\.has\(normalizePrivateNumber\(room\.peerPrivateNumber\)\)/);
  assert.match(client, /vault-list-avatar\$\{hasLiveStatus \? ' has-live-status' : ''\}/);
  assert.match(client, /\.vault-list-avatar\.has-live-status\{box-shadow:0 0 0 3px #E34B63\}/);
});

test('status composer previews content before selecting contacts', () => {
  assert.match(client, /id="status-compose-content"[\s\S]*onclick="openStatusAudience\(\)">Next/);
  assert.match(client, /id="status-compose-audience" hidden><h2>Select contacts<\/h2>/);
  assert.match(client, /function openStatusAudience\(\)[\s\S]*status-compose-content'\)\.hidden = true[\s\S]*status-compose-audience'\)\.hidden = false/);
  assert.match(client, /function backToStatusContent\(\)[\s\S]*status-compose-audience'\)\.hidden = true/);
  assert.match(client, /\.status-media-preview\[hidden\]\{display:none\}/);
});

test('own status viewer uses compact icon-only actions', () => {
  assert.match(client, /aria-label="Add status update"[\s\S]*aria-label="View status viewers"[\s\S]*aria-label="Delete status"/);
  assert.match(client, /status-view-actions\$\{item\.own\?' status-owner-actions':''\}/);
  assert.match(client, /\.status-icon-action\{width:54px;height:54px/);
  assert.doesNotMatch(client, />Add update<\/button>|>\$\{item\.viewers\?\.length\|\|0\} viewed<\/button>|>Delete<\/button>/);
});
