const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('account registration safely handles a lost first response', () => {
  assert.match(server, /existingNumberOwner === d\.accountId/);
  assert.match(server, /verifyAccountSecret\(d\.authSecret, existing\.authVerifier\)/);
  assert.match(server, /replaceAccountLoginSession\(d\.accountId, existing, accountDeviceHash\(d\.deviceId\)\)/);
  assert.match(client, /registrationRetryDelays = \[350, 900, 1800, 3200\]/);
  assert.match(client, /for \(let attempt = 0; attempt < 5; attempt\+\+\)/);
  assert.match(client, /isTransientRegistrationResponse\(result\)/);
  assert.match(client, /const responseText = await res\.text\(\)/);
  assert.match(client, /recordRegistrationDiagnostic\('failed'/);
  assert.match(client, /Registration returned no response/);
  assert.match(client, /\[account-register\]/);
  assert.match(client, /cryptoPreparationError:true/);
  assert.match(client, /function prewarmAccountCrypto\(\)/);
  assert.match(client, /cryptoRetryDelays = \[250, 700, 1400, 2400\]/);
  assert.match(client, /attempt < 5/);
  assert.match(client, /registrationStage === 'secure preparation'/);
  assert.match(client, /Registration encryption was not prepared/);
  const idempotentCheck = server.indexOf('existing && existingNumberOwner === d.accountId');
  const creationRateLimit = server.indexOf('account-register-ip:');
  assert.ok(idempotentCheck >= 0 && creationRateLimit > idempotentCheck,
    'authenticated registration retries must run before new-identity rate limiting');
  assert.match(server, /account-register-ip:\$\{ip\}`, 30/);
  assert.match(server, /account-register-id:\$\{d\.accountId\}`, 6/);
});

test('identity creation displays an accessible code-native text scramble transition', () => {
  assert.match(client, /id="account-creation-transition"[^>]*aria-label="Creating your private identity"[^>]*hidden/);
  assert.match(client, /IDENTITY_SCRAMBLE_TARGET = 'Creating your private identity'/);
  assert.match(client, /startIdentityCreationTransition\(\)/);
  assert.match(client, /await stopIdentityCreationTransition\(accountCreated\)/);
  assert.match(client, /prefers-reduced-motion: reduce/);
});

test('successful identity creation morphs dots into the Vaultlix wordmark', () => {
  assert.match(client, /id="account-creation-success-phase"[^>]*aria-label="Vaultlix identity created"[^>]*hidden/);
  assert.match(client, /id="account-dot-word"/);
  assert.match(client, /stencilContext\.fillText\('Vaultlix'/);
  assert.match(client, /await runIdentityDotMorph\(\)/);
  assert.match(client, /stopIdentityCreationTransition\(accountCreated\)/);
});
