const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

test('installed apps keep native download and share actions separate', () => {
  assert.match(client, /function downloadDataUri\(dataUri, filename\)[\s\S]{0,120}transferDataUri\(dataUri, filename, 'save'\)/);
  assert.match(client, /function shareDataUri\(dataUri, filename\)[\s\S]{0,120}transferDataUri\(dataUri, filename, 'share'\)/);
  assert.match(client, /function shareOpenPdf\(\)[\s\S]{0,180}shareDataUri\(/);
  assert.match(client, /VaultlixAndroid\.shareMedia\(dataUri, filename/);
  assert.match(client, /action:nativeAction === 'share' \? 'shareMedia' : 'saveMedia'/);
  assert.match(client, /VaultlixAndroid\.saveMedia\(dataUri, filename/);
  assert.match(android, /public boolean shareMedia\(String dataUrl, String requestedName\)/);
  assert.match(android, /public boolean saveMedia\(String dataUrl, String requestedName\)/);
  assert.match(android, /Intent\.createChooser\(sendIntent, "Save or share"\)/);
  assert.match(android, /Intent\.ACTION_CREATE_DOCUMENT/);
  assert.match(ios, /if action == "shareMedia"/);
  assert.match(ios, /if action == "saveMedia"/);
  assert.match(ios, /presentShareImage\(fileURL\)/);
  assert.match(ios, /presentSaveFile\(fileURL\)/);
});

test('ordinary image and file messages can be forwarded into another encrypted conversation', () => {
  assert.match(client, /\['file', 'album', 'text'\]\.includes\(rec\.kind\) && !rec\.viewOnce/);
  assert.match(client, /showForwardAttachmentPicker\(rec\.kind === 'text'/);
  assert.match(client, /async function forwardAttachmentToRoom\(target, rec\)/);
  assert.match(client, /await sendAlbumMessage\(target, items, false\)/);
  assert.match(client, /await sendFileMessage\(target, file, rec\.base64/);
  assert.match(client, /if \(rec\.viewOnce\) \{ toast\('View-once photos cannot be forwarded'/);
});

test('forward picker filters contacts and confirms the selected recipient immediately', () => {
  assert.match(client, /data-forward-search placeholder="Search contacts"/);
  assert.match(client, /safeProfileImageUri\(room\.peerProfileImage\)/);
  assert.match(client, /profileImage[\s\S]{0,140}<img src="\$\{profileImage\}"/);
  assert.match(client, /button\.dataset\.forwardName\.includes\(query\)/);
  assert.match(client, /textContent = 'Sending…'/);
  assert.match(client, /textContent = '✓ Sent'/);
  assert.match(client, /setTimeout\(close, 550\)/);
});
