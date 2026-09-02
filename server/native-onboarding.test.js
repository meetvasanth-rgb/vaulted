const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('installed apps use a dedicated three-step first-run journey', () => {
  assert.match(client, /id="s-native-onboarding"/);
  assert.match(client, /data-native-onboarding-page="welcome"/);
  assert.match(client, /data-native-onboarding-page="identity"/);
  assert.match(client, /data-native-onboarding-page="notifications"/);
  assert.match(client, /if \(isNativeApp\(\)\) openNativeOnboarding\('welcome'\)/);
});

test('native onboarding requests notification access only after user action', () => {
  assert.match(client, /async function finishNativeOnboarding\(enableNotifications\)/);
  assert.match(client, /if \(enableNotifications\) await requestNativePushPermission\(\)/);
  assert.match(client, /Message contents stay hidden from notification services/);
});

test('account creation and sign-in continue to the notification step', () => {
  assert.match(client, /localStorage\.setItem\(NATIVE_ONBOARDING_KEY, 'notifications'\)/);
  assert.match(client, /openNativeOnboarding\('notifications'\)/);
  assert.match(client, /native-onboarding-account/);
});
