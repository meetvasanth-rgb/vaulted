'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');

test('direct and group chat Gallery actions request device photos and videos', () => {
  assert.match(client, /id="image-input"[^>]*accept="image\/\*,video\/\*"/);
  assert.match(client, /id="group-image-input"[^>]*accept="image\/\*,video\/\*"/);
  assert.match(client, /id="file-input"[^>]*accept="application\/pdf/);
  assert.match(client, /id="group-file-input"[^>]*accept="application\/pdf/);
});

test('direct and group chats can send gallery photos as original document files', () => {
  assert.match(client, /id="photo-document-input"[^>]*accept="image\/\*,\.heic,\.heif"[^>]*onchange="handlePhotoDocumentSelect\(event\)"/);
  assert.match(client, /id="group-photo-document-input"[^>]*accept="image\/\*,\.heic,\.heif"[^>]*onchange="handlePrivateGroupFileSelect\(event\)"/);
  assert.match(client, /sendSelectedFilesToRoom\(room, files, \{ imageAsDocument:true \}\)/);
  assert.match(client, /file\.type\.startsWith\('image\/'\) && imageAsDocument[\s\S]{0,500}documents\.push\(\{ file, base64/);
  assert.match(groups, /event\.target\.id === 'group-photo-document-input'/);
});

test('camera actions remain image capture requests', () => {
  assert.match(client, /id="camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(client, /id="group-camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
});
