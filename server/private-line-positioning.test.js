const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const install = fs.readFileSync(path.join(__dirname, '..', 'client', 'install.html'), 'utf8');

test('consumer-facing positioning presents Vaultlix as a private line', () => {
  assert.match(client, /prestigious secondary private number/);
  assert.match(client, /Vaultlix gives you a second number/);
  assert.match(client, /data-i18n="new_connection">Extend your line</);
  assert.match(install, /your private line with a secondary private number/);
  assert.doesNotMatch(`${client}\n${install}`, /encrypted messenger/i);
});

test('security-critical recovery and Emergency Exit wording stays precise', () => {
  assert.match(client, /Vaultlix never receives the readable code/);
  assert.match(client, /losing both this device and the recovery code permanently loses this Private Number/);
  assert.match(client, /nobody—including Vaultlix—can restore the encrypted account/);
  assert.match(client, /Emergency Exit/);
  assert.match(client, /This cannot be undone/);
});
