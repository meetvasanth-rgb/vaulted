'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const statusStore = fs.readFileSync(path.join(__dirname, 'status-store.js'), 'utf8');

test('status composer accepts images and videos and enforces a twenty second video duration', () => {
  assert.match(client, /accept="image\/\*,video\/\*"/);
  assert.match(client, />Add image or video<\/button>/);
  assert.match(client, /const MAX_STATUS_VIDEO_SECONDS = 20/);
  assert.match(client, /duration > MAX_STATUS_VIDEO_SECONDS \+ 0\.05/);
  assert.doesNotMatch(client.slice(client.indexOf('async function prepareStatusMedia'), client.indexOf('async function publishStatus')), /12 \* 1024 \* 1024/);
});

test('status audience is a full-screen, readable contact picker with circular selections', () => {
  assert.match(client, /status-composer\.audience-open\{padding:0;background:#fff;place-items:stretch\}/);
  assert.match(client, /status-audience label\{gap:13px;padding:13px 10px;font:650 17px/);
  assert.match(client, /status-audience input\[type="checkbox"\]\{[^}]*border-radius:50%/);
  assert.match(client, /input\[type="checkbox"\]:checked\{background:#682C43/);
  assert.match(client, /classList\.add\('audience-open'\)/);
  assert.match(client, /classList\.remove\('audience-open'\)/);
});

test('status videos are encrypted locally and stored once outside recipient envelopes', () => {
  assert.match(client, /createVideoAttachmentThumbnail\(file, 720\)/);
  assert.match(client, /button\.textContent='Optimising video…';[\s\S]*compressVideoFile\(statusComposerVideo\.file\)/);
  assert.match(client, /new Blob\(chunks, \{ type:optimised\.mime \|\| statusComposerVideo\.mime \}\)/);
  assert.match(client, /crypto\.subtle\.encrypt\([\s\S]*uploadVideo\.arrayBuffer\(\)/);
  assert.match(client, /thumbnail:statusComposerVideo\.thumbnail \|\| null/);
  assert.match(client, /crypto\.subtle\.encrypt\([\s\S]*status\/media\/prepare[\s\S]*body:ciphertext/);
  assert.match(client, /videoEnvelope = \{ mediaId, key:/);
  assert.match(server, /statusMediaObjectKey/);
  assert.match(server, /objectStorage\.sizeOf\(pendingMedia\.objectKey\)/);
  assert.match(postgres, /CREATE TABLE IF NOT EXISTS encrypted_status_media/);
  assert.match(statusStore, /media_id uuid/);
});

test('authorized viewers download and decrypt status videos locally', () => {
  assert.match(server, /statusStore\.canAccessMedia\(d\.accountId, d\.mediaId\)/);
  assert.match(server, /status\/media\/content[\s\S]*objectStorage\.open\(media\.objectKey\)[\s\S]*body\.pipe\(res\)/);
  assert.match(client, /status\/media\/content[\s\S]*crypto\.subtle\.decrypt/);
  assert.match(client, /controller\.abort\(\), 30000/);
  assert.match(client, /function retryStatusVideo\(\)/);
  assert.match(client, /<video class="status-video-player" src=/);
  assert.match(client, /status-video-loading-preview/);
  assert.match(client, /safeMessageImagePreview\(item\.payload\.thumbnail\)/);
});

test('decrypted status videos survive feed refresh and upcoming videos preload in memory', () => {
  assert.match(client, /const previousById = new Map\(statusFeed\.map/);
  assert.match(client, /payload = previous\.payload/);
  assert.match(client, /retainedVideoUrls[\s\S]*URL\.revokeObjectURL/);
  assert.match(client, /function scheduleStatusVideoPreload\(\)[\s\S]*selected\.length === 2[\s\S]*hydrateStatusVideo\(item\)/);
});

test('a newly published own video reuses its local playable bytes on iOS', () => {
  assert.match(client, /ownVideoUrl = URL\.createObjectURL\(uploadVideo\)/);
  assert.match(client, /pendingOwnStatusVideoUrls\.set\(result\.id, ownVideoUrl\)/);
  assert.match(client, /pendingOwnStatusVideoUrls\.get\(item\.id\)/);
  assert.match(client, /payload\.videoUrl = pendingOwnVideo/);
  assert.match(client, /if \(ownVideoUrl\) URL\.revokeObjectURL\(ownVideoUrl\)/);
});

test('status video never exposes native playback chrome and keeps status navigation above it', () => {
  assert.match(client, /class="status-video-player"[\s\S]*onplaying="revealStatusViewerVideo\(this\)"/);
  assert.match(client, /onloadeddata="ensureStatusViewerVideoPlayback\(this\)"/);
  assert.match(client, /webkit-playsinline/);
  assert.match(client, /class="status-video-startup"/);
  assert.match(client, /function revealStatusViewerVideo\(video, allowManualPlayback = false\)[\s\S]*video\.controls = false/);
  assert.match(client, /const tapZones=`<button type="button" class="status-tap-zone status-prev"[\s\S]*status-tap-zone status-next/);
  assert.doesNotMatch(client, /const tapZones=item\.payload\.type==='video'\?'':/);
  assert.match(client, /className = 'status-video-manual-play'/);
  assert.match(client, /function ensureStatusViewerVideoPlayback\(video\)[\s\S]*video\.paused[\s\S]*revealStatusViewerVideo\(video, true\)/);
  assert.match(client, /function requestStatusViewerVideoPlayback\(video, allowMutedFallback = false\)[\s\S]*video\.muted = true;[\s\S]*showStatusViewerSoundButton\(video\)/);
  assert.match(client, /function requestStatusViewerVideoPlayback\(video, allowMutedFallback = false\)[\s\S]*prepareVoiceNotePlayback\(\);[\s\S]*await video\.play\(\)/);
  assert.match(client, /statusViewerItems\.slice\(statusViewerIndex \+ 1, statusViewerIndex \+ 3\)[\s\S]*hydrateStatusVideo\(candidate\)/);
  assert.match(client, /ontimeupdate="finishStatusViewerVideo\(this\)" onended="finishStatusViewerVideo\(this\)"/);
  assert.match(client, /function finishStatusViewerVideo\(video\)[\s\S]*statusViewerStep\(1\)/);
  assert.doesNotMatch(client, /class="status-video-player"[^>]* controls/);
});

test('cold start prioritizes status conversations and refreshes as soon as their key is ready', () => {
  assert.match(client, /if \(statusFeedLoading\) \{[\s\S]*statusFeedRefreshQueued = true/);
  assert.match(client, /if \(!room\?\.sharedKey\) \{[\s\S]*prioritizeStartupRoomRestore\(room\.code\)/);
  assert.match(client, /startupRoomRestorePriorityCodes\.add\(code\)[\s\S]*uniqueCodes\.filter\(code => startupRoomRestorePriorityCodes\.has\(code\)\)/);
  assert.match(client, /statusFeedRefreshedAt = waitingForRoomKeys \? 0 : Date\.now\(\)/);
  assert.match(client, /const statusKeyWasAwaited = statusFeedWaitingRoomCodes\.delete\(room\.code\);[\s\S]*if \(canRestoreHistory && \(statusKeyWasAwaited \|\| statusFeedLoading\)\) \{[\s\S]*statusFeedRefreshedAt = 0;[\s\S]*refreshStatusFeed\(\{ quiet:true \}\)/);
});
