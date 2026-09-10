const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

test('installed apps hand received media to the native save/share sheet', () => {
  assert.match(client, /action:'shareMedia', dataUrl:dataUri, filename:/);
  assert.match(client, /VaultlixAndroid\.shareMedia\(dataUri, filename/);
  assert.match(android, /public boolean shareMedia\(String dataUrl, String requestedName\)/);
  assert.match(android, /Intent\.createChooser\(sendIntent, "Save or share"\)/);
  assert.match(ios, /if action == "shareMedia"/);
  assert.match(ios, /presentShareImage\(fileURL\)/);
});

test('ordinary image and file messages can be forwarded into another encrypted conversation', () => {
  assert.match(client, /canForward = kind === 'file' \|\| kind === 'album'/);
  assert.match(client, /showForwardAttachmentPicker\(rec\)/);
  assert.match(client, /async function forwardAttachmentToRoom\(target, rec\)/);
  assert.match(client, /await sendAlbumMessage\(target, items, false\)/);
  assert.match(client, /await sendFileMessage\(target, file, rec\.base64/);
  assert.match(client, /if \(rec\.viewOnce\) \{ toast\('View-once photos cannot be forwarded'/);
});

