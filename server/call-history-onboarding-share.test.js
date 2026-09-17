const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const mainActivity = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const callActivity = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/NativeCallActivity.java'), 'utf8');
const iosCallManager = fs.readFileSync(path.join(root, 'mobile/ios/App/App/AppDelegate.swift'), 'utf8');

test('completed calls are synchronized idempotently without duplicate local replay', () => {
  assert.match(server, /existingMessage = \(room\.msgs \|\| \[\]\)\.find/);
  assert.match(server, /duplicate:true/);
  assert.match(client, /room\.seenMsgIds\?\.add\(rec\.id\)/);
});

test('native Android outgoing calls generate routed ringback until connection or ending', () => {
  assert.match(mainActivity, /EXTRA_OUTGOING, true/);
  assert.match(callActivity, /AudioTrack\.Builder/);
  assert.match(callActivity, /USAGE_VOICE_COMMUNICATION_SIGNALLING/);
  assert.match(callActivity, /Math\.sin\(2\.0 \* Math\.PI \* 440\.0/);
  assert.match(callActivity, /onConnected\(\).*stopRingback\(\)/);
  assert.match(callActivity, /finishingCall = true;\s*stopRingback\(\)/);
});

test('native iOS outgoing calls generate routed ringback until connection or ending', () => {
  assert.match(iosCallManager, /ringbackCallID = action\.callUUID/);
  assert.doesNotMatch(iosCallManager, /ringbackCallID = action\.callUUID\s+startRingbackIfPossible\(\)/);
  assert.match(iosCallManager, /didActivate audioSession:[\s\S]*callKitAudioSessionActive = true[\s\S]*asyncAfter[\s\S]*startRingbackIfPossible\(\)/);
  assert.match(iosCallManager, /guard let callID = ringbackCallID,\s+callKitAudioSessionActive,/);
  assert.match(iosCallManager, /AVAudioPlayerNode\(\)/);
  assert.match(iosCallManager, /scheduleBuffer\(buffer, at: nil, options: \.loops\)/);
  assert.match(iosCallManager, /nativeCallDidConnect[\s\S]*stopRingback\(callID: callID\)/);
  assert.match(iosCallManager, /perform action: CXEndCallAction[\s\S]*stopRingback\(callID: action\.callUUID\)/);
  assert.match(client, /callState === 'outgoing'[\s\S]*outgoingSpeakerBtnHtml[\s\S]*toggleSpeaker\(\)/);
  assert.match(iosCallManager, /overrideOutputAudioPort\(enabled \? \.speaker : \.none\)[\s\S]*restartRingbackForCurrentRoute\(\)/);
  assert.match(iosCallManager, /func audioRouteDidChange\(\)[\s\S]*restartRingbackForCurrentRoute\(\)/);
  assert.match(iosCallManager, /restartRingbackForCurrentRoute[\s\S]*stopRingbackPlayer\(\)[\s\S]*startRingbackIfPossible\(\)/);
});

test('number generation exposes its remaining allowance and own profile can share', () => {
  assert.match(server, /generationsRemaining:remaining/);
  assert.match(client, /id="account-generation-counter"/);
  assert.match(client, /result\.generationsRemaining/);
  assert.match(client, /function shareOwnPrivateNumber\(\)/);
  assert.match(client, /renderNumberCard\(state\)/);
  assert.match(client, /shareNumberCard/);
});

test('public invitations retain branded previews while number-card QR uses the verified app-link route', () => {
  const association = fs.readFileSync(path.join(root, 'client/.well-known/apple-app-site-association'), 'utf8');
  const associationJson = JSON.parse(association);
  assert.match(association, /\/\?\?\?\?\?\?\?\?\?\?/);
  assert.match(association, /"appID": "3KLX2S84MV\.com\.vaultlix\.app"/);
  assert.match(server, /apple-app-site-association'[\s\S]*Cache-Control'[\s\S]*no-cache, no-store/);
  const associationText = JSON.stringify(associationJson);
  for (let digits = 6; digits <= 10; digits++) {
    assert.match(associationText, new RegExp(`/${'\\?'.repeat(digits)}`));
  }
  assert.match(client, /id="public-profile-open-app"/);
  assert.match(client, /vaultlix:\/\/connect\/\$\{encodeURIComponent\(result\.profile\.privateNumber\)\}/);
  assert.match(client, /og:image:secure_url/);
  assert.match(client, /og:image:alt[^>]+Vaultlix private messaging logo/);
  const shareBody = client.slice(client.indexOf('async function shareOwnPrivateNumber'), client.indexOf('async function blockedVaultFingerprint'));
  assert.match(shareBody, /https:\/\/vaultlix\.com\/\$\{privateNumber\}\?ref=qr/);
  assert.match(client, /intent:\/\/connect\/\$\{privateNumber\}#Intent;scheme=vaultlix;package=com\.vaultlix\.app/);
  assert.match(shareBody, /VaultlixAndroid\.shareImage/);
  assert.match(shareBody, /navigator\.share\(\{ title:'My Vaultlix Private Number', files:\[file\] \}\)/);
});

test('number-card preparation starts quietly before the first Android share tap', () => {
  assert.match(client, /function scheduleNumberCardPrewarm/);
  assert.match(client, /requestIdleCallback\(work, \{ timeout:1200 \}\)/);
  assert.match(client, /if \(state\) scheduleNumberCardPrewarm\(state\)/);
  assert.match(client, /overlay\?\.classList\.add\('open'\)[\s\S]*await renderNumberCard\(state\)/);
});

test('Android App Links authorize the certificate used by direct tester builds', () => {
  const association = JSON.parse(fs.readFileSync(path.join(root, 'client/.well-known/assetlinks.json'), 'utf8'));
  const vaultlixTarget = association.find((entry) => entry?.target?.package_name === 'com.vaultlix.app');
  assert.ok(vaultlixTarget);
  assert.ok(vaultlixTarget.target.sha256_cert_fingerprints.includes(
    'DC:24:C4:65:C6:F8:53:F7:65:6C:7A:B8:41:70:7E:2C:4D:B3:A1:31:8F:A5:71:37:F3:3F:DD:6A:2C:DA:03:25'
  ));
});
