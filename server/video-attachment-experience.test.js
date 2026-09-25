const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');
const iosScene = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');

test('direct and group attachment sends remain visible with encrypted upload animation', () => {
  assert.match(client, /function attachmentUploadAnimationHtml/);
  assert.match(client, /class="vault-upload-orbit"/);
  assert.match(client, /pending:true[\s\S]{0,700}room\.messages\.push\(rec\)[\s\S]{0,900}await encryptMsg/);
  assert.match(groups, /pending:true[\s\S]{0,300}group\.messages = [\s\S]{0,500}await encryptPrivateGroupValue/);
  assert.match(client, /Encrypting image/);
  assert.match(client, /if \(others\.length\) progress\?\.close\(\)/);
  assert.doesNotMatch(client.slice(client.indexOf('async function handleFileSelect'), client.indexOf('async function sendFileMessage')), /Sending securely/);
  assert.doesNotMatch(client.slice(client.indexOf('async function handleFileSelect'), client.indexOf('async function sendAlbumMessage')), /Preparing photo/);
});

test('temporary encrypted attachment fetch failures retry before showing unavailable', () => {
  assert.match(client, /const ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS = \[0, 500, 1500, 4000\]/);
  assert.match(client, /attempt < ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS\.length/);
  assert.match(client, /status === 404 \|\| status === 408 \|\| status === 409/);
  assert.match(client, /status === 425 \|\| status === 429 \|\| status >= 500/);
  assert.match(client, /if \(!retryable \|\| attempt === ATTACHMENT_DOWNLOAD_RETRY_DELAYS_MS\.length - 1\) break/);
  assert.match(client, /kind:'attachment-loading'/);
  assert.match(client, /Loading encrypted attachment/);
  assert.match(client, /room\.messages\[existingIndex\] = rec/);
});

test('video attachments carry an encrypted thumbnail and open in the in-app player', () => {
  assert.match(client, /function createVideoAttachmentThumbnail/);
  assert.match(client, /document\.body\.appendChild\(video\)/);
  assert.match(client, /requestVideoFrameCallback/);
  assert.match(client, /video\.currentTime = Math\.min\(1, Math\.max\(\.12, duration \* \.1\)\)/);
  assert.match(client, /videoThumb:safeVideoThumb/);
  assert.match(client, /function buildVideoAttachmentHtml/);
  assert.match(client, /function openVideoAttachmentViewer/);
  assert.match(client, /function encryptedMediaObjectUrl/);
  assert.match(client, /new Blob\(chunks, \{ type:mime \}\)/);
  assert.match(client, /video\.src = objectUrl/);
  assert.match(client, /URL\.revokeObjectURL\(objectUrl\)/);
  assert.doesNotMatch(client, /video\.src = `data:\$\{mime\};base64,\$\{base64\}`/);
  assert.doesNotMatch(client, /video\.onerror\s*=\s*\(\)\s*=>\s*\{[^}]*removeMessageRecord/);
  assert.match(client, /The encrypted video is still available/);
  assert.match(client, /action\.textContent = 'Save video'/);
  assert.match(client, /className = 'video-attachment-download'/);
  assert.match(client, /downloadDataUri\(`data:\$\{mime\};base64,\$\{base64\}`/);
  assert.match(client, /className = 'video-attachment-share'/);
  assert.match(client, /shareDataUri\(`data:\$\{mime\};base64,\$\{base64\}`/);
  assert.match(client, /className = 'video-attachment-controls'/);
  assert.match(client, /className = 'video-attachment-seek'/);
  assert.match(client, /const playbackRates = \[1, 1\.5, 2, \.5\]/);
  assert.match(client, /if \(video\.paused\) startPlayback\(\); else video\.pause\(\)/);
  assert.match(client, /function attachVideoViewerSwipeDown/);
  assert.match(client, /deltaY >= 90/);
  assert.match(client, /video\.controls = false/);
  assert.match(client, /video\.onplaying = revealPlayingVideo/);
  assert.match(client, /className = 'video-attachment-viewer loading'/);
  assert.match(client, /function handleVideoTap/);
  assert.match(client, /function handleVideoActionsTap/);
  assert.match(client, /class="msg-video-play"[^>]*onclick="event\.stopPropagation\(\);/);
  assert.match(client, /\.msg-video-card'\)/);
  assert.match(client, /isVideoReply/);
  assert.match(client, /mediaType:replyTo\.mediaType/);
  assert.match(groups, /function openPrivateGroupVideo/);
  assert.match(groups, /videoThumb:safeImageDataUri/);
  assert.match(groups, /payload\.data\.length > 36 \* 1024 \* 1024/);
});

test('new attachment experience is shipped through a fresh app-shell cache', () => {
  assert.match(sw, /vaultlix-app-shell-v67/);
});

test('iOS-on-Mac videos use native AVPlayer and web playback cannot spin forever', () => {
  assert.match(client, /window\.__vaultlixIOSAppOnMac === true/);
  assert.match(client, /action:'playVideoOnMac'/);
  assert.match(client, /This video is taking too long to open\./);
  assert.match(client, /setTimeout\([\s\S]{0,500}Save video[\s\S]{0,300}10000\)/);
  assert.match(iosScene, /import AVKit/);
  assert.ok(iosScene.includes('window.__vaultlixIOSAppOnMac = \\(runsOnMac ? "true" : "false");'));
  assert.match(iosScene, /action == "playVideoOnMac"/);
  assert.match(iosScene, /message\.frameInfo\.isMainFrame/);
  assert.match(iosScene, /securityOrigin\.host == "vaultlix\.com"/);
  assert.match(iosScene, /AVPlayerViewController\(\)/);
  assert.match(iosScene, /data\.count <= 25 \* 1024 \* 1024/);
});

test('media-heavy Android chats release hidden decoders and avoid identical inbox rebuilds', () => {
  assert.match(client, /const leavingChat = id !== 's-chat'/);
  assert.match(client, /function unloadDeferredKlipyGif\(img\)/);
  assert.match(client, /else unloadDeferredKlipyGif\(entry\.target\)/);
  assert.match(client, /if \(body\._vaultlixChatListHtml === html\) return;/);
  assert.match(client, /loading="lazy" decoding="async"/);
  assert.match(client, /function scheduleMessageImagePreviews/);
  assert.match(client, /makeTinyThumbnail\(target\.base64, target\.mime, 640, 0\.76\)/);
  assert.match(client, /const safeSrc = safeMessageImagePreview\(rec\.imagePreview\)/);
  assert.match(client, /const safeSrc = hidden \? null : safeMessageImagePreview\(img\.imagePreview\)/);
  assert.match(client, /imagePreview:safeImagePreview/);
  assert.match(client, /imagePreview:safeMessageImagePreview\(img\.preview\)/);
  assert.match(client, /const MAX_MESSAGE_IMAGE_PREVIEW_BASE64 = 1024 \* 1024/);
  assert.match(client, /plaintext\.length > 256 \* 1024/);
  assert.match(client, /if \(!room\.historyLoaded && !uniqueVisibleConversationRecords\(room\.messages\)\.length\)/);
  assert.match(client, /Could not load encrypted messages/);
  assert.match(client, /function retryChatHistory\(\)/);
  assert.match(client, /if \(canRestoreHistory && room\.code === preferredRestoreCode\) restoreRoomHistoryInBackground\(room\)/);
});
