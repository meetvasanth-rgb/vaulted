const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');

test('postgres keeps four prior opaque account bundle revisions', () => {
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS account_bundle_history/);
  assert.match(postgres, /encrypted_bundle <> \$2/);
  assert.match(postgres, /ORDER BY created_at DESC, revision DESC LIMIT 4/);
  assert.match(postgres, /async loadAccountBundleHistory\(accountId, limit = 4\)/);
});

test('only the authenticated account can fetch recovery candidates', () => {
  assert.match(server, /path === '\/api\/account\/recovery-candidates'/);
  assert.match(server, /authenticateAccountSession\(d\.accountId, d\.sessionToken\)/);
  assert.match(server, /postgresStore\.loadAccountBundleHistory\(d\.accountId, 4\)/);
  assert.match(server, /validEncryptedField\(item\?\.bundle, ACCOUNT_BUNDLE_MAX_BYTES\)/);
});

test('room recovery proves a historical key against ciphertext before adopting it', () => {
  assert.match(client, /api\('\/api\/account\/recovery-candidates'/);
  assert.match(client, /requireAccountReauthenticationForRecovery\(latest, history\)/);
  assert.match(client, /Sign in again to restore encrypted conversations/);
  assert.match(client, /for \(const encryptedBundle of encryptedBundles\)/);
  assert.match(client, /await decryptMsgWithSharedKey\(derived\.sharedKey, sample\.content\)/);
  assert.match(client, /room\.myKeyPair = derived\.pair/);
});

test('private groups inspect current and historical encrypted bundles', () => {
  assert.match(groups, /api\('\/api\/account\/recovery-candidates'/);
  assert.match(groups, /requireAccountReauthenticationForRecovery\(latest, history\)/);
  assert.match(groups, /for \(const bundle of bundles\)/);
  assert.match(groups, /const merged = \{ \.\.\.backedUp\.keys, \.\.\.\(group\.keys \|\| \{\}\) \}/);
});
