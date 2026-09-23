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

test('status videos are encrypted locally and stored once outside recipient envelopes', () => {
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
  assert.match(client, /<video src=/);
});
