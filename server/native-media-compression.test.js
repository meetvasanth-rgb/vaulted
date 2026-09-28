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

test('direct and group videos compress before encryption, streamed to native in chunks, with no oversized-original fallback', () => {
  assert.match(client, /async function compressVideoFile\(file, controller = null\)/);
  assert.match(client, /nativeChunkedVideoCompressionAvailable/);
  assert.match(client, /const MAX_VIDEO_SOURCE_BYTES = 100 \* 1024 \* 1024/);
  assert.match(client, /const VIDEO_COMPRESSION_CHUNK_BYTES = 2 \* 1024 \* 1024/);
  assert.match(client, /action:'beginVideoCompression'/);
  assert.match(client, /action:'appendVideoCompressionChunk'/);
  assert.match(client, /action:'finishVideoCompression'/);
  assert.match(client, /action:'cancelVideoCompression'/);
  assert.match(client, /compressedBytes < file\.size && compressedBytes <= MAX_FILE_SIZE/);
  // A video that genuinely needs compression to fit and can't get there
  // must never fall back to the raw original — it has to return null and
  // the caller must refuse to send it, not silently upload it anyway.
  assert.match(client, /if \(!mustCompress\) return \{ base64: await fileToBase64\(file\), mime: file\.type, name: file\.name \};\s*\n\s*return null;/);
  assert.match(client, /const compressedVideo = isVideo \? await compressVideoFile\(file, currentVideoController\) : null/);
  assert.doesNotMatch(client, /action:'compressVideo'/);
  assert.match(groups, /compressVideoFile\(file, currentVideoController\)/);
  assert.match(groups, /mime = compressedVideo\.mime/);
  // Both send paths must refuse an oversized video rather than upload it.
  for (const source of [client, groups]) {
    assert.match(source, /couldn.t be compressed under 25MB/);
  }
});

test('a cancelled video compression is distinguished from a genuine failure on both send paths', () => {
  assert.match(client, /return \{ cancelled: true \};/);
  assert.match(client, /if \(isVideo && compressedVideo\?\.cancelled\) continue;/);
  assert.match(groups, /if \(isVideo && compressedVideo\?\.cancelled\) continue;/);
  assert.match(client, /cancelBtn\.className = 'photo-send-cancel'/);
  assert.match(client, /cancelNativeVideoCompression\(requestId\)/);
});

test('Android streams chunks to a temp file and retries at a lower quality tier before giving up', () => {
  assert.match(gradle, /media3-transformer:1\.11\.1/);
  assert.match(gradle, /media3-effect:1\.11\.1/);
  assert.match(android, /public boolean supportsChunkedVideoCompression\(\) \{ return true; \}/);
  assert.match(android, /public boolean beginVideoCompression\(/);
  assert.match(android, /public boolean appendVideoCompressionChunk\(/);
  assert.match(android, /public void finishVideoCompression\(/);
  assert.match(android, /public void cancelVideoCompression\(/);
  assert.match(android, /MAX_CHUNKED_VIDEO_SOURCE_BYTES = 100 \* 1024 \* 1024/);
  assert.match(android, /MAX_COMPRESSED_VIDEO_BYTES = 25 \* 1024 \* 1024/);
  assert.match(android, /VIDEO_COMPRESSION_TIER_HEIGHTS = \{ 720, 480 \}/);
  assert.match(android, /VIDEO_COMPRESSION_TIER_BITRATES = \{ 2_500_000, 1_200_000 \}/);
  assert.match(android, /Presentation\.createForHeight\(VIDEO_COMPRESSION_TIER_HEIGHTS\[tier\]\)/);
  assert.match(android, /setVideoMimeType\(MimeTypes\.VIDEO_H264\)/);
  assert.match(android, /setAudioMimeType\(MimeTypes\.AUDIO_AAC\)/);
  assert.match(android, /bytes\.length < originalSize/);
  assert.match(android, /retryOrFailVideoCompression/);
  assert.doesNotMatch(android, /public boolean compressVideo\(/);
  assert.doesNotMatch(android, /supportsNativeMediaCompression/);
});

test('iOS streams chunks to a temp file and retries at a lower quality tier before giving up', () => {
  assert.match(ios, /__vaultlixChunkedMediaCompression = true/);
  assert.match(ios, /func beginVideoCompression\(/);
  assert.match(ios, /func appendVideoCompressionChunk\(/);
  assert.match(ios, /func finishVideoCompression\(/);
  assert.match(ios, /func cancelVideoCompression\(/);
  assert.match(ios, /maxChunkedVideoSourceBytes = 100 \* 1024 \* 1024/);
  assert.match(ios, /maxCompressedVideoBytes = 25 \* 1024 \* 1024/);
  assert.match(ios, /\[AVAssetExportPreset1280x720, AVAssetExportPreset640x480, AVAssetExportPresetMediumQuality\]/);
  assert.match(ios, /exporter\.outputFileType = \.mp4/);
  assert.match(ios, /exporter\.shouldOptimizeForNetworkUse = true/);
  assert.match(ios, /compressed\.count < originalSize/);
  assert.match(ios, /attemptVideoExport/);
  assert.doesNotMatch(ios, /func compressVideoForMessaging/);
});

test('large compressed videos remain downloadable and shareable in both native apps, with the 25MB output ceiling enforced natively', () => {
  assert.match(android, /totalBytes > MAX_CHUNKED_VIDEO_SOURCE_BYTES/);
  assert.match(android, /bytes\.length <= MAX_COMPRESSED_VIDEO_BYTES/);
  assert.match(ios, /totalBytes <= Self\.maxChunkedVideoSourceBytes/);
  assert.match(ios, /compressed\.count <= Self\.maxCompressedVideoBytes/);
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
