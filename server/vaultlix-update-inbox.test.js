const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');

const client = readFileSync('client/index.html', 'utf8');

test('Vaultlix update inbox row shows useful copy and only badges unseen updates', () => {
  assert.match(client, /const seen=vaultlixSeenUpdateIds\(\)\.has\(item\.id\);/);
  assert.match(client, /const preview=String\(item\.body\|\|item\.title\|\|''\)\.trim\(\);/);
  assert.match(client, /vault-list-row-name">Vaultlix<\/span>/);
  assert.doesNotMatch(client, /Vaultlix Updates<\/span>/);
  assert.doesNotMatch(client, /'Video update'/);
  assert.match(client, /\$\{seen\?'':'<span class="vault-list-row-unread">1<\/span>'\}/);
});

test('opening any Vaultlix update clears its local unread state', () => {
  assert.match(client, /markVaultlixUpdateSeen\(item\.id\);renderVaultList\(\);/);
  assert.doesNotMatch(client, /if\(item\.viewOnce\)\{\s*markVaultlixUpdateSeen/);
});
