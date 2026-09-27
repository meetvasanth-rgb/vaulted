'use strict';

// "Share externally" hands a received (or sent) photo, video, document or voice
// note to the OS share sheet — decrypted on this device, as a temporary file the
// native side deletes afterward — so it can go to WhatsApp or any other app.
// This is separate from Forward, which stays inside Vaultlix, still encrypted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

function extract(source, name, keyword = 'function') {
  const start = source.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('shareMessageRecord hands the file to the OS share sheet, never to Forward\'s send path', () => {
  const fn = extract(client, 'shareMessageRecord');
  assert.match(fn, /shareDataUri\(`data:\$\{rec\.mime\};base64,\$\{rec\.base64\}`, `voice-note\.\$\{ext\}`\)/);
  assert.match(fn, /shareDataUri\(`data:\$\{rec\.mime\};base64,\$\{rec\.base64\}`, rec\.fileName\)/);
  assert.doesNotMatch(fn, /forwardAttachmentToRoom|api\('\/api\/send'|showForwardAttachmentPicker/);
});

test('shareDataUri reuses the same native path as Save (temporary file, OS sheet, cleaned up), just the "share" action instead of "save"', () => {
  assert.match(client, /function shareDataUri\(dataUri, filename\)\s*\{\s*transferDataUri\(dataUri, filename, 'share'\);\s*\}/);
  const transfer = extract(client, 'transferDataUri');
  assert.match(transfer, /action:nativeAction === 'share' \? 'shareMedia' : 'saveMedia'/);
  assert.match(transfer, /nativeAction === 'share' && typeof window\.VaultlixAndroid\?\.shareMedia === 'function'/);
  assert.match(android, /public boolean shareMedia\(String dataUrl, String requestedName\)/);
  assert.match(android, /shared-media/, 'a dedicated, purgeable cache directory, not a permanent download');
  assert.match(ios, /if action == "shareMedia"/);
  assert.match(ios, /presentShareImage\(fileURL\)/);
});

test('the selection bar\'s More menu offers Share externally alongside Save, and the "more" button appears for it', () => {
  const menu = extract(client, 'toggleMessageMoreMenu');
  assert.match(menu, /if \(state\.canShare\) items\.push\(`<button type="button" role="menuitem" data-more="share">\$\{selectionIconSvg\('share'\)\}<span>Share externally<\/span><\/button>`\);/);
  assert.match(client, /show\('more', !!\(state\.canCopy \|\| state\.canSave \|\| state\.canShare\)\);/);
  const menuClick = client.slice(client.indexOf("menu.addEventListener('click'"), client.indexOf("menu.addEventListener('click'") + 400);
  assert.match(menuClick, /else if \(item\.dataset\.more === 'share'\) controller\.share\(\);/);
});

test('direct chats: Share externally needs exactly one photo, video, document or voice note selected — never text, never several at once', () => {
  const controller = extract(client, 'directSelectionController');
  assert.match(controller, /canShare: !!one && \['file', 'voice'\]\.includes\(rec\?\.kind\)/);
  assert.match(controller, /share\(\) \{ const one = chosen\(\)\[0\]; exitSelectMode\(\); if \(one\) shareMessageRecord\(one\.entry\.rec\); \}/);
});

test('groups: the same rule, using the group\'s own attachment kinds', () => {
  const controller = extract(groups, 'groupSelectionController');
  assert.match(controller, /canShare: !!id && usableRow\(id\) && \['image', 'file', 'voice'\]\.includes\(kind\)/);
  assert.match(controller, /share\(\) \{ const id = chosen\(\)\[0\]; exitPrivateGroupSelectMode\(\); if \(id\) sharePrivateGroupAttachment\(id\); \}/);
  const share = extract(groups, 'sharePrivateGroupAttachment');
  assert.match(share, /shareDataUri\(`data:\$\{mime\};base64,\$\{attachment\.data\}`, attachment\.name \|\| fallbackName\)/);
  assert.doesNotMatch(share, /showForwardAttachmentPicker/);
});

test('the full-screen photo viewer offers Share next to Save, for both direct and group photos, not for view-once', () => {
  const chrome = extract(client, 'buildViewerChrome');
  assert.match(chrome, /\$\{ctx\.hideDownload \? '' : `<button type="button" data-v="share" aria-label="Share externally"/);
  assert.match(chrome, /case 'share': \{ const src = ctx\.getSrc\(\); const ext = \(String\(src\)\.match\(\/\^data:image\\\/\(\\w\+\)\/\) \|\| \[\]\)\[1\] \|\| 'jpg'; shareDataUri\(src, `vaultlix-image\.\$\{ext\}`\); break; \}/);
  // View-once viewers never pass `info`, so buildViewerChrome (and its Share/Save
  // buttons) never runs for them at all.
  assert.doesNotMatch(client, /viewImage\(safeSrc, \{\s*hideDownload: true,\s*info/);
});
