const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('inbox bottom bar exposes add, chats and calls as equal navigation actions', () => {
  const bar = client.match(/<div class="vault-list-actions">[\s\S]*?<\/div>\s*<\/div>\s*<!-- CLOSED -->/)?.[0] || '';
  assert.match(bar, /onclick="openNewConnection\(\)"/);
  assert.match(bar, /id="vault-nav-chats"[\s\S]*setVaultListMode\('chats'\)/);
  assert.match(bar, /id="vault-nav-calls"[\s\S]*setVaultListMode\('calls'\)/);
  assert.match(client, /\.vault-list-actions\{[\s\S]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
});

test('calls view is derived only from decrypted encrypted-conversation call records', () => {
  assert.match(client, /function callHistoryEntries\(\)[\s\S]*for \(const room of rooms\.values\(\)\)[\s\S]*uniqueVisibleConversationRecords\(room\.messages\)[\s\S]*callHistoryFamily\(rec\)/);
  assert.match(client, /function renderCallHistoryList\(body\)[\s\S]*callHistoryEntries\(\)[\s\S]*openVaultListRoom\(el\.dataset\.room\)/);
  assert.doesNotMatch(client, /function renderCallHistoryList\(body\)[\s\S]{0,1200}(?:api\(|fetch\()/);
});
