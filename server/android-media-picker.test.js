'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('direct and group chat Gallery actions request device photos and videos', () => {
  assert.match(client, /id="image-input"[^>]*accept="image\/\*,video\/\*"/);
  assert.match(client, /id="group-image-input"[^>]*accept="image\/\*,video\/\*"/);
  assert.match(client, /id="file-input"[^>]*accept="application\/pdf/);
  assert.match(client, /id="group-file-input"[^>]*accept="application\/pdf/);
});

test('camera actions remain image capture requests', () => {
  assert.match(client, /id="camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(client, /id="group-camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
});
