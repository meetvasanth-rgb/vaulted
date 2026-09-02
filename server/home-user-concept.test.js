const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('home page explains the private-number user model', () => {
  assert.match(client, /Be known by your Vaultlix number—not your phone number/);
  assert.match(client, /01 · Identify/);
  assert.match(client, /02 · Approve/);
  assert.match(client, /03 · Connect/);
  assert.match(client, /People must know the exact number and you decide whether to connect/);
});

test('user-facing legacy vault labels are replaced with conversation language', () => {
  for (const legacy of [
    'Create a vault',
    'Vault ready',
    'Label this vault',
    'Tap to open vault',
    'Private vault',
    'Vault erased',
    'Start a new vault',
    'Make this a permanent vault?',
  ]) assert.equal(client.includes(legacy), false, `legacy label remains: ${legacy}`);
});
