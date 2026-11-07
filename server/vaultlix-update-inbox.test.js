const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const client = readFileSync('client/index.html', 'utf8');

test('official Vaultlix updates render in Status instead of the chat inbox', () => {
  assert.match(client, /function vaultlixStatusCircleHtml\(item\)/);
  assert.match(client, /data-vaultlix-status-update/);
  assert.match(client, /status-person-name">Vaultlix<\/span>/);
  assert.match(client, /const viewed=vaultlixSeenUpdateIds\(\)\.has\(item\.id\);/);
  assert.match(client, /status-ring\$\{viewed\?' viewed':''\}/);
  assert.match(client, /vaultlixUpdateExpiryTimer=setTimeout\(\(\)=>\{vaultlixUpdateExpiryTimer=null;renderStatusRail\(\);\}/);
  assert.match(client, /let html = searchQuery \? '' : inviteCardHtml\(\) \+ avatarOfferHtml\(\) \+ dailyLookNudgeHtml\(\) \+ requestsRowHtml\(\);/);
  assert.doesNotMatch(client, /vaultlixUpdateRowHtml\(latestVaultlixUpdate\)/);
  assert.doesNotMatch(client, /'Video update'/);
});

test('opening any Vaultlix update clears its local unread state', () => {
  assert.match(client, /markVaultlixUpdateSeen\(item\.id\);renderVaultList\(\);/);
  assert.doesNotMatch(client, /if\(item\.viewOnce\)\{\s*markVaultlixUpdateSeen/);
});
