const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

function inputTag(id) {
  const match = client.match(new RegExp(`<input[^>]*id="${id}"[^>]*>`));
  assert.ok(match, `missing input ${id}`);
  return match[0];
}

test('Android password managers ignore device-only and conversation-local secrets', () => {
  const localSecretIds = [
    'password-input',
    'app-lock-passcode',
    'app-lock-current',
    'app-lock-new',
    'app-lock-confirm',
    'locker-setup-password',
    'locker-setup-confirm',
    'locker-unlock-password',
  ];

  for (const id of localSecretIds) {
    const input = inputTag(id);
    assert.match(input, /class="[^"]*local-secret-input[^"]*"/);
    assert.match(input, /type="text"/);
    assert.match(input, /autocomplete="off"/);
  }
  assert.match(client, /\.hidden-chats-secret-input,\.local-secret-input\{-webkit-text-security:disc\}/);
});

test('account credentials remain eligible for normal password-manager autofill', () => {
  for (const id of ['account-login-password', 'account-current-password']) {
    const input = inputTag(id);
    assert.match(input, /type="password"/);
    assert.match(input, /autocomplete="current-password"/);
  }
  for (const id of ['account-create-password', 'account-recover-password']) {
    const input = inputTag(id);
    assert.match(input, /type="password"/);
    assert.match(input, /autocomplete="new-password"/);
  }
});
