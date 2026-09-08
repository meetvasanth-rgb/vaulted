'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { WIDTH, HEIGHT, BRAND, createNumberCardSvg } = require('../client/number-card');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('share-card screenshot remains visually stable at 1080 by 1350', () => {
  const qrMatrix = Array.from({ length:21 }, (_, row) =>
    Array.from({ length:21 }, (_, column) => (row * column + row + column) % 3 === 0));
  const svg = createNumberCardSvg({
    number:'2480599999', username:'Avery', tier:'founding', qrMatrix,
  });
  assert.equal(WIDTH, 1080);
  assert.equal(HEIGHT, 1350);
  assert.equal(BRAND, '#6B1F3A');
  assert.equal(
    crypto.createHash('sha256').update(svg).digest('hex'),
    'c049d3559615a995a02ad9638c08b25db3a9b09d8a1a54e8f748796e1202d278',
  );
});

test('number-card QR contains only the private app deep link', () => {
  assert.match(client, /qr\.addData\(`vaultlix:\/\/connect\/\$\{privateNumber\}`\)/);
  assert.doesNotMatch(client, /quickConnectQrMatrix[\s\S]{0,500}https:\/\/vaultlix\.com/);
  assert.doesNotMatch(client, /console\.(?:info|log)\([^\n]*number-card/);
});

test('number card explains the scan and includes a readable connection fallback', () => {
  const svg = createNumberCardSvg({
    number:'2480599999', username:'Vasanthkumar', tier:'founding', qrMatrix:[[true]],
  });
  assert.match(svg, /Scan to request a private, encrypted chat with/);
  assert.match(svg, /Vasanthkumar — no phone number needed/);
  assert.match(svg, /vaultlix\.com\/24-8059-9999/);
  assert.doesNotMatch(svg, /Scan to extend a private line/);
});

test('native apps prepare the image before opening the system share sheet', () => {
  const android = readFileSync(join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
  const ios = readFileSync(join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
  assert.match(android, /boolean sharePreparedImage\(\)[\s\S]*Intent\.ACTION_SEND/);
  assert.match(ios, /action == "shareImage"[\s\S]*presentShareImage\(fileURL\)/);
  assert.match(ios, /func presentShareImage[\s\S]*UIActivityViewController/);
  assert.match(android, /setClipData\(ClipData\.newRawUri/);
  assert.match(android, /boolean prepareShareImage\(String dataUrl\)/);
  assert.match(android, /boolean sharePreparedImage\(\)/);
  assert.match(android, /boolean shareImage\(String dataUrl\)/);
  assert.match(ios, /action == "prepareShareImage"/);
  assert.match(ios, /action == "sharePreparedImage"/);
  assert.match(ios, /vaultlix:share-image-presented/);
  assert.match(client, /numberCardAssetPromise = prepareNumberCardAsset\(canvas\)/);
  assert.match(client, /prepareNativeNumberCard\(asset\.dataUrl\)/);
  assert.match(client, /VaultlixAndroid\.sharePreparedImage\(\)/);
  assert.doesNotMatch(client, /Card saved as an image|downloadDataUri\(asset\.dataUrl/);
  const shareFunction = client.match(/async function shareNumberCard\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.doesNotMatch(shareFunction, /shareText|https:\/\/vaultlix\.com|navigator\.share\([^)]*url:/);
  assert.match(shareFunction, /sharePreparedImage\(\) === true/);
  assert.doesNotMatch(shareFunction, /postMessage\(\{ action:'sharePreparedImage' \}\);\s*closeNumberCard\(\)/);
});
