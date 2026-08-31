const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('Android hides app content before entering the app switcher', () => {
  const source = fs.readFileSync(path.join(
    root,
    'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'
  ), 'utf8');
  assert.match(source, /protected void onPause\(\)\s*\{\s*showAppSwitcherPrivacyCover\(\);\s*super\.onPause\(\);/s);
  assert.match(source, /protected void onResume\(\)\s*\{\s*super\.onResume\(\);\s*hideAppSwitcherPrivacyCover\(\);/s);
  assert.doesNotMatch(source, /FLAG_SECURE/);
});

test('iOS covers the scene while inactive and removes the cover when active', () => {
  const source = fs.readFileSync(path.join(
    root,
    'mobile/ios/App/App/SceneDelegate.swift'
  ), 'utf8');
  assert.match(source, /func sceneWillResignActive\([^)]*\)\s*\{\s*showAppSwitcherPrivacyCover\(\)/s);
  assert.match(source, /func sceneDidBecomeActive\([^)]*\)\s*\{\s*hideAppSwitcherPrivacyCover\(\)/s);
});
