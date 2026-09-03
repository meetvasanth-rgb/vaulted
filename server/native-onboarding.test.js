const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const androidActivity = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const androidManifest = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

test('installed apps use a dedicated first-run journey with Android full-screen call access', () => {
  assert.match(client, /id="s-native-onboarding"/);
  assert.match(client, /data-native-onboarding-page="welcome"/);
  assert.match(client, /data-native-onboarding-page="identity"/);
  assert.match(client, /data-native-onboarding-page="notifications"/);
  assert.match(client, /data-native-onboarding-page="fullscreen-calls"/);
  assert.match(client, /openFullScreenCallSettings/);
  assert.match(client, /canUseFullScreenCalls/);
  assert.match(androidManifest, /android\.permission\.USE_FULL_SCREEN_INTENT/);
  assert.match(androidActivity, /manager\.canUseFullScreenIntent\(\)/);
  assert.match(androidActivity, /Settings\.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT/);
  assert.match(client, /if \(isNativeApp\(\)\) openNativeOnboarding\('welcome'\)/);
});

test('native onboarding requests notification and full-screen access only after user action', () => {
  assert.match(client, /await requestNativePushPermission\(\)/);
  assert.match(client, /if \(nativePlatform\(\) === 'android'\) openNativeOnboarding\('fullscreen-calls'\)/);
  assert.match(client, /Message contents stay hidden from notification services/);
});

test('account creation and sign-in continue to the notification step', () => {
  assert.match(client, /localStorage\.setItem\(NATIVE_ONBOARDING_KEY, 'notifications'\)/);
  assert.match(client, /openNativeOnboarding\('notifications'\)/);
  assert.match(client, /native-onboarding-account/);
});
