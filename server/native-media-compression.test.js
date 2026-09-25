const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client', 'groups.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const gradle = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'build.gradle'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
const messaging = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

test('photos use a high-quality mobile-size compression profile', () => {
  assert.match(client, /const MAX_DIM = 1600/);
  assert.match(client, /const QUALITY = 0\.82/);
  assert.match(client, /if \(!blob \|\| blob\.size >= file\.size\)/);
});

test('direct and group videos compress before encryption with safe original fallback', () => {
  assert.match(client, /async function compressVideoFile\(file\)/);
  assert.match(client, /supportsNativeMediaCompression/);
  assert.match(client, /action:'compressVideo'/);
  assert.match(client, /compressed\.length >= originalBase64\.length/);
  assert.match(client, /const compressedVideo = isVideo \? await compressVideoFile\(file\) : null/);
  assert.match(groups, /compressVideoFile\(file\)/);
  assert.match(groups, /mime = compressedVideo\.mime/);
});

test('Android uses hardware-backed 720p H264 AAC transcoding', () => {
  assert.match(gradle, /media3-transformer:1\.11\.1/);
  assert.match(gradle, /media3-effect:1\.11\.1/);
  assert.match(android, /Presentation\.createForHeight\(720\)/);
  assert.match(android, /setBitrate\(2_500_000\)/);
  assert.match(android, /setVideoMimeType\(MimeTypes\.VIDEO_H264\)/);
  assert.match(android, /setAudioMimeType\(MimeTypes\.AUDIO_AAC\)/);
  assert.match(android, /bytes\.length < originalSize/);
});

test('iOS uses the system 720p H264 AAC export preset', () => {
  assert.match(ios, /__vaultlixNativeMediaCompression = true/);
  assert.match(ios, /AVAssetExportPreset1280x720/);
  assert.match(ios, /exporter\.outputFileType = \.mp4/);
  assert.match(ios, /exporter\.shouldOptimizeForNetworkUse = true/);
  assert.match(ios, /compressed\.count < sourceData\.count/);
});

test('large compressed videos remain downloadable and shareable in both native apps', () => {
  assert.match(android, /dataUrl\.length\(\) > 36_000_000/);
  assert.match(android, /bytes\.length > 25 \* 1024 \* 1024/);
  assert.match(ios, /dataURL\.count <= 36_000_000/);
  assert.match(ios, /data\.count <= 25 \* 1024 \* 1024/);
});

test('message notifications use the new original Vaultlix chime', () => {
  assert.match(messaging, /vaultlix_messages_bright_v1/);
  assert.match(messaging, /R\.raw\.vault_chime/);
  assert.match(server, /sound: 'vault_chime\.caf'/);
  assert.match(server, /sound: 'vault_chime'/);
});

test('Android startup avoids synchronous caching of multi-megabyte media history', () => {
  assert.match(client, /if \(plaintext\.length > 256 \* 1024\) return/);
  assert.match(client, /room\.code === preferredRestoreCode/);
  assert.match(client, /!room\.historyLoaded && !room\.historyRestorePromise/);
});
