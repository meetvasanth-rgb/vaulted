const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');
const sw = fs.readFileSync(path.join(__dirname, '..', 'client', 'sw.js'), 'utf8');

test('direct and group attachment sends remain visible with encrypted upload animation', () => {
  assert.match(client, /function attachmentUploadAnimationHtml/);
  assert.match(client, /class="vault-upload-orbit"/);
  assert.match(client, /pending:true[\s\S]{0,700}room\.messages\.push\(rec\)[\s\S]{0,900}await encryptMsg/);
  assert.match(groups, /pending:true[\s\S]{0,300}group\.messages = [\s\S]{0,500}await encryptPrivateGroupValue/);
  assert.match(client, /Encrypting image/);
  assert.doesNotMatch(client.slice(client.indexOf('async function handleFileSelect'), client.indexOf('async function sendAlbumMessage')), /Preparing photo/);
});

test('video attachments carry an encrypted thumbnail and open in the in-app player', () => {
  assert.match(client, /function createVideoAttachmentThumbnail/);
  assert.match(client, /videoThumb:safeVideoThumb/);
  assert.match(client, /function buildVideoAttachmentHtml/);
  assert.match(client, /function openVideoAttachmentViewer/);
  assert.match(client, /function handleVideoTap/);
  assert.match(groups, /function openPrivateGroupVideo/);
  assert.match(groups, /videoThumb:safeImageDataUri/);
  assert.match(groups, /payload\.data\.length > 36 \* 1024 \* 1024/);
});

test('new attachment experience is shipped through a fresh app-shell cache', () => {
  assert.match(sw, /vaultlix-app-shell-v44/);
});
