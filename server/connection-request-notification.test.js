const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('connection requests use account-level native notifications', () => {
  assert.match(server, /\/api\/account\/native-push-subscribe/);
  assert.match(server, /sent you a connection request/);
  assert.match(server, /recipient\.account\.pushDestinations/);
  assert.match(postgres, /push_destinations jsonb/);
  assert.match(client, /registerNativeTokenForAccount/);
});

test('connection UI uses conversation language and one encryption label', () => {
  assert.match(client, /Send connection request/);
  assert.doesNotMatch(client, /Request a private vault/);
  assert.doesNotMatch(client, /e2e-bar::after\{content:'Encrypted'/);
  assert.match(client, /private_vault:'Private conversation'/);
});
