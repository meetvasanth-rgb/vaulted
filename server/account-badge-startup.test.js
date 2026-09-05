const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const clientHtml = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('account badge is refreshed during normal page startup', () => {
  assert.match(clientHtml, /document\.addEventListener\('DOMContentLoaded', \(\) => \{\s*\/\/[^]*?updateAccountSettingsStatus\(\);/);
});

test('mobile web does not promote PWA installation', () => {
  assert.doesNotMatch(clientHtml, /id="install-btn"/);
  assert.doesNotMatch(clientHtml, /id="ios-install-banner"/);
  assert.doesNotMatch(clientHtml, /Install Vaultlix for the best experience/);
});

test('account status updates both landing account labels', () => {
  assert.match(clientHtml, /landing-account-label/);
  assert.match(clientHtml, /landing-footer-account-label/);
  assert.match(clientHtml, /footerAccountLabel\.textContent = state \? state\.displayName : 'Sign in'/);
});
