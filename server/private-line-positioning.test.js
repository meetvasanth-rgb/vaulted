const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const install = fs.readFileSync(path.join(__dirname, '..', 'client', 'install.html'), 'utf8');
const getApp = fs.readFileSync(path.join(__dirname, '..', 'client', 'get-app.html'), 'utf8');

test('consumer-facing positioning presents Vaultlix as a messenger with an app-specific identity', () => {
  assert.match(client, /Private Encrypted Messenger/);
  assert.match(client, /Vaultlix is a private encrypted messenger/);
  assert.match(client, /app-specific Vaultlix number/);
  assert.match(client, /not a cellular number or virtual SIM service/);
  assert.match(client, /data-i18n="new_connection">Add your friend</);
  assert.match(install, /private encrypted messenger for chats, media sharing, voice calls and video calls/i);
  assert.match(getApp, /https:\/\/apps\.apple\.com\/in\/app\/vaultlix\/id6798266989/);
  assert.match(getApp, /https:\/\/play\.google\.com\/store\/apps\/details\?id=com\.vaultlix\.app/);
  assert.match(getApp, /Download on the App Store/);
  assert.match(getApp, /Get it on Google Play/);
  assert.doesNotMatch(client, /prestigious secondary private number|Vaultlix gives you a second number/);
});

test('security-critical recovery and Emergency Exit wording stays precise', () => {
  assert.match(client, /Vaultlix never receives the readable code/);
  assert.match(client, /losing both this device and the recovery code permanently loses this Private Number/);
  assert.match(client, /nobody—including Vaultlix—can restore the encrypted account/);
  assert.match(client, /Emergency Exit/);
  assert.match(client, /This cannot be undone/);
});
