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
