const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

test('the complete application uses the platform-native WhatsApp-style font stack', () => {
  assert.match(client, /--vaultlix-system-font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif/);
  assert.match(client, /body \*,[\s\S]{0,180}body \*::before,[\s\S]{0,180}body \*::after\{font-family:var\(--vaultlix-system-font\)!important\}/);
  assert.doesNotMatch(client, /fonts\.googleapis\.com/);
  assert.ok(client.lastIndexOf('id="vaultlix-native-typography"') > client.lastIndexOf("font-family:'Manrope'"));
});
