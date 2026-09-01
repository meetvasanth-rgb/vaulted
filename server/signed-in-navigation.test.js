const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.resolve(__dirname, '../client/index.html'), 'utf8');

test('landing sign-in entry routes an existing account to its inbox', () => {
  assert.match(client, /onclick="openLoginOrInbox\(\)"/);
  assert.match(client, /function openLoginOrInbox\(\)[\s\S]*loadAccountState\(\)[\s\S]*showScreen\('s-vault-list'\)/);
});

test('signed-in identity panel exposes new connection directly', () => {
  assert.match(client, /id="account-signed-view"[\s\S]*openNewConnection\(\)[\s\S]*Sign out on this device/);
});

test('leaving a conversation requires explicit confirmation', () => {
  assert.match(client, /async function leaveActiveRoom\(\)[\s\S]*confirm\(LEAVE_VAULT_CONFIRMATIONS\[currentAppLanguage\(\)\][\s\S]*\/api\/leave/);
});
