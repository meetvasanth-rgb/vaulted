const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('account registration safely handles a lost first response', () => {
  assert.match(server, /existingNumberOwner === d\.accountId/);
  assert.match(server, /verifyAccountSecret\(d\.authSecret, existing\.authVerifier\)/);
  assert.match(server, /newAccountSession\(existing\)/);
  assert.match(client, /for \(let attempt = 0; attempt < 3; attempt\+\+\)/);
  assert.match(client, /attempt === 0 \? 500 : 1500/);
  assert.match(client, /Registration returned no response/);
  assert.match(client, /\[account-register\]/);
  assert.match(client, /cryptoPreparationError:true/);
  assert.match(client, /attempt === 0 \? 200 : 600/);
  assert.match(client, /Registration encryption was not prepared/);
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
