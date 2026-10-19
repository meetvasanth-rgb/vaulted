const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('Android registers Vaultlix for one or many shared images', () => {
  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml');
  assert.match(manifest, /android\.intent\.action\.SEND[\s\S]*?android:mimeType="image\/\*"/);
  assert.match(manifest, /android\.intent\.action\.SEND_MULTIPLE[\s\S]*?android:mimeType="image\/\*"/);
  const activity = read('mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java');
  assert.match(activity, /captureExternalShare\(getIntent\(\)\)/);
  assert.match(activity, /window\.vaultlixReceiveExternalShare/);
  assert.match(activity, /25 \* 1024 \* 1024/);
});

test('iOS embeds a photo Share Extension with the same private app group', () => {
  const project = read('mobile/ios/App/App.xcodeproj/project.pbxproj');
  assert.match(project, /VaultlixShare\.appex in Embed Foundation Extensions/);
  assert.match(project, /productType = "com\.apple\.product-type\.app-extension"/);
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER = com\.vaultlix\.app\.Share/);
  const plist = read('mobile/ios/App/VaultlixShare/Info.plist');
  assert.match(plist, /com\.apple\.share-services/);
  assert.match(plist, /NSExtensionActivationSupportsImageWithMaxCount/);
  const entitlements = read('mobile/ios/App/VaultlixShare/VaultlixShare.entitlements');
  assert.match(entitlements, /group\.com\.vaultlix\.app/);
  const controller = read('mobile/ios/App/VaultlixShare/ShareViewController.swift');
  assert.match(controller, /openButton\.setTitle\("Done"/);
  assert.match(controller, /then open Vaultlix/);
  assert.doesNotMatch(controller, /extensionContext\?\.open\(/);
  const scene = read('mobile/ios/App/App/SceneDelegate.swift');
  assert.match(scene, /flushPendingExternalShares\(\)/);
  assert.match(scene, /window\.vaultlixReceiveExternalShare/);
});

test('the recipient chooser feeds shared images into the existing encrypted attachment path', () => {
  const client = read('client/index.html');
  assert.match(client, /window\.vaultlixReceiveExternalShare = function/);
  assert.match(client, /if \(quickLockActive\) return false/);
  assert.match(client, /postMessage\(\{ action:'flushExternalShares' \}\)/);
  assert.match(client, /showExternalShareChooser\(\)/);
  assert.match(client, /await sendSelectedFilesToRoom\(room, files\)/);
  assert.match(client, /encryptedPayload = await encryptMsg\(room, payload\)/);
  const scene = read('mobile/ios/App/App/SceneDelegate.swift');
  assert.match(scene, /if action == "flushExternalShares" \{\s*flushPendingExternalShares\(\)/);
});
