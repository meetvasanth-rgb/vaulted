const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const mainActivity = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');

test('warm Android notification opens its conversation without reloading the WebView', () => {
  assert.match(mainActivity, /openNotificationTargetWithoutReload\(uri\);/);
  assert.match(mainActivity, /typeof window\.vaultlixOpenNotificationTarget!=='function'/);
  assert.match(mainActivity, /evaluateJavascript\(script, result ->/);
  assert.match(mainActivity, /if \(!"true"\.equals\(result\)\) webView\.loadUrl\(uri\.toString\(\)\);/);
});

test('notification targets wait behind App Lock and continue after unlock', () => {
  assert.match(client, /function openPendingNotificationTarget\(\) \{[\s\S]*if \(quickLockActive\) return false;/);
  assert.match(client, /function completeQuickUnlock\(\) \{[\s\S]*openPendingNotificationTarget\(\);/);
  assert.match(client, /window\.vaultlixOpenNotificationTarget = \(kind, target\) =>/);
});

test('cold Android notification launches retain the URL restore fallback', () => {
  assert.match(mainActivity, /current == null \|\| !current\.startsWith\("https:\/\/vaultlix\.com\/"\)/);
  assert.match(mainActivity, /webView\.loadUrl\(uri\.toString\(\)\);/);
});
