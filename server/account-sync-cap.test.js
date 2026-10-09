const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

test('large account sync is available only to a pre-authenticated account session', () => {
  assert.match(server, /const ACCOUNT_BUNDLE_MAX_BYTES = 8 \* 1024 \* 1024/);
  assert.match(server, /if \(validAccountId\(accountId\) && authenticateAccountSession\(accountId, sessionToken\)\) \{\s*return BODY_LIMIT_ACCOUNT_SYNC_AUTHENTICATED/);
  assert.match(server, /return 1100 \* 1024;\s*\}\s*if \(pathname === '\/api\/account\/register'/);
  assert.match(server, /validEncryptedField\(d\.bundle, ACCOUNT_BUNDLE_MAX_BYTES\)/);
});

test('the account sync client authenticates before sending its encrypted body', () => {
  const apiStart = client.indexOf('async function api(path, data = null)');
  const apiEnd = client.indexOf('const ENCRYPTED_ATTACHMENT_PREFIX', apiStart);
  const api = client.slice(apiStart, apiEnd);
  assert.match(api, /path === '\/api\/account\/sync'/);
  assert.match(api, /headers\['X-Vaultlix-Account'\] = data\.accountId/);
  assert.match(api, /headers\['X-Vaultlix-Session'\] = data\.sessionToken/);
});

test('sign-out distinguishes expired sessions, large bundles and ordinary sync failures without erasing data', () => {
  assert.match(client, /lastAccountSyncFailure\?\.status === 401[\s\S]*reason:'session'/);
  assert.match(client, /lastAccountSyncFailure\?\.status === 413[\s\S]*reason:'size'/);
  assert.match(client, /backupResult\?\.reason === 'session'\) setTimeout\(showAccountReauthentication/);
  assert.match(client, /Nothing was removed/);
});
