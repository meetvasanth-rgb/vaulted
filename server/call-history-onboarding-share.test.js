const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const mainActivity = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const callActivity = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/NativeCallActivity.java'), 'utf8');

test('completed calls are synchronized idempotently without duplicate local replay', () => {
  assert.match(server, /existingMessage = \(room\.messages \|\| \[\]\)\.find/);
  assert.match(server, /duplicate:true/);
  assert.match(client, /room\.seenMsgIds\?\.add\(rec\.id\)/);
});

test('native Android outgoing calls play ringback only until connection or ending', () => {
  assert.match(mainActivity, /EXTRA_OUTGOING, true/);
  assert.match(callActivity, /ToneGenerator\.TONE_SUP_RINGTONE/);
  assert.match(callActivity, /onConnected\(\).*stopRingback\(\)/);
  assert.match(callActivity, /finishingCall = true;\s*stopRingback\(\)/);
});

test('number generation exposes its remaining allowance and own profile can share', () => {
  assert.match(server, /generationsRemaining:remaining/);
  assert.match(client, /id="account-generation-counter"/);
  assert.match(client, /result\.generationsRemaining/);
  assert.match(client, /function shareOwnPrivateNumber\(\)/);
  assert.match(client, /https:\/\/vaultlix\.com\/\$\{state\.privateNumber\}\?ref=share/);
  assert.match(client, /navigator\.share/);
});

test('Private Number invitations are app links with one URL and branded previews', () => {
  const association = fs.readFileSync(path.join(root, 'client/.well-known/apple-app-site-association'), 'utf8');
  assert.match(association, /\/\?\?\?\?\?\?\?\?\?\?/);
  assert.match(client, /og:image:secure_url/);
  assert.match(client, /og:image:alt[^>]+Vaultlix private messaging logo/);
  const shareBody = client.slice(client.indexOf('async function shareOwnPrivateNumber'), client.indexOf('async function blockedVaultFingerprint'));
  assert.doesNotMatch(shareBody, /const text = `[^`]*\$\{url\}/);
  assert.match(shareBody, /navigator\.share\(\{ title:'Connect with me on Vaultlix', text, url \}\)/);
});
