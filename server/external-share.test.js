'use strict';

// "Share externally" hands a single photo, video, document or voice note to the
// OS share sheet — decrypted on this device, as a temporary file the native side
// deletes afterward — so it can go to WhatsApp or any other app. It lives inside
// the Forward sheet (next to the Vaultlix contacts, or on its own for a voice
// note, which is never forwarded into Vaultlix), not the ⋮ More menu, and it is
// separate from Forward itself, which stays inside Vaultlix, still encrypted.

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
  assert.doesNotMatch(fn, /forwardAttachmentToRoom|api\('\/api\/send'/);
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

test('Share externally is not in the ⋮ More menu any more', () => {
  const menu = extract(client, 'toggleMessageMoreMenu');
  assert.doesNotMatch(menu, /canShare|data-more="share"/);
  assert.match(menu, /Share externally lives inside the Forward sheet/, 'a pointer to where it moved');
  assert.match(client, /show\('more', !!\(state\.canCopy \|\| state\.canSave\)\);/);
  assert.doesNotMatch(client, /'share'\) controller\.share\(\)/);
  // Nothing calls a `.share()` selection-controller method any more — Share moved
  // into showForwardAttachmentPicker, driven directly off the record.
  assert.doesNotMatch(extract(client, 'directSelectionController'), /canShare|\bshare\(\) \{/);
  assert.doesNotMatch(extract(groups, 'groupSelectionController'), /canShare|\bshare\(\) \{/);
});

test('Forward opens for a single voice note too, purely to reach Share (a voice note is never forwarded into Vaultlix)', () => {
  const direct = extract(client, 'directSelectionController');
  assert.match(direct, /canForward: \(items\.length > 0 && items\.every\(item => messageForwardable\(item\.entry\.rec\)\)\) \|\| \(!!one && rec\?\.kind === 'voice'\)/);
  const group = extract(groups, 'groupSelectionController');
  assert.match(group, /canForward: \(ids\.length > 0 && ids\.every\(item => usableRow\(item\) && \['text', 'image', 'file'\]\.includes\(groupMessageKind\(messageOf\(item\)\)\)\)\)\s*\n\s*\|\| \(!!id && usableRow\(id\) && kind === 'voice'\)/);
  // messageForwardable itself is unchanged: voice never goes into the Vaultlix send path.
  assert.match(client, /function messageForwardable\(rec\) \{\s*return !!rec && \['file', 'album', 'text'\]\.includes\(rec\.kind\)/);
});

test('groups: a voice note still reaches the Forward sheet as a shareable record, just never as a Vaultlix-forward target', () => {
  const fn = extract(groups, 'groupMessageToForwardRec');
  assert.match(fn, /if \(attachment\.type === 'group-voice'\) return \{ kind:'voice', mime, base64:attachment\.data \};/);
});

test('the Forward sheet shows a "Share to another app" row for a single photo, video, document or voice note, in addition to (or instead of) the Vaultlix contact list', () => {
  const fn = extract(client, 'showForwardAttachmentPicker');
  assert.match(fn, /const shareRec = input\.length === 1 && input\[0\] && \['file', 'voice'\]\.includes\(input\[0\]\.kind\) && !input\[0\]\.viewOnce \? input\[0\] : null;/);
  assert.match(fn, /data-forward-share/);
  assert.match(fn, /shareButton\.onclick = \(\) => \{ close\(\); shareMessageRecord\(shareRec\); \};/);
  // A voice note (not in `recs`, the in-Vaultlix-forward list) still gets a sheet via shareRec.
  assert.match(fn, /if \(!recs\.length && !shareRec\) \{/);
  assert.match(fn, /const targets = recs\.length \? \[\.\.\.rooms\.values\(\)\]\.filter/);
});

test('the full-screen photo viewer keeps its own Share button next to Save, for both direct and group photos, not for view-once', () => {
  const chrome = extract(client, 'buildViewerChrome');
  assert.match(chrome, /\$\{ctx\.hideDownload \? '' : `<button type="button" data-v="share" aria-label="Share externally"/);
  assert.match(chrome, /case 'share': \{ const src = ctx\.getSrc\(\); const ext = \(String\(src\)\.match\(\/\^data:image\\\/\(\\w\+\)\/\) \|\| \[\]\)\[1\] \|\| 'jpg'; shareDataUri\(src, `vaultlix-image\.\$\{ext\}`\); break; \}/);
  // View-once viewers never pass `info`, so buildViewerChrome (and its Share/Save
  // buttons) never runs for them at all.
  assert.doesNotMatch(client, /viewImage\(safeSrc, \{\s*hideDownload: true,\s*info/);
});
