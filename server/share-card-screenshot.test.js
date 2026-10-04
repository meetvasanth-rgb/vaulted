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
    'cf11c29226e6348026b8eabc26f1b86da315a53cb3e33d00973d206852c0b92f',
  );
});

test('number-card QR uses the cross-platform verified app-link route', () => {
  assert.match(client, /qr\.addData\(quickConnectQrUrl\(privateNumber, profileShareCode\)\)/);
  assert.match(client, /quickConnectQrMatrix[\s\S]{0,500}quickConnectQrUrl\(privateNumber, profileShareCode\)/);
  assert.doesNotMatch(client, /console\.(?:info|log)\([^\n]*number-card/);
});

test('number card explains the scan and includes a readable connection fallback', () => {
  const svg = createNumberCardSvg({
    number:'2480599999', shareCode:'ABC234', username:'Vasanthkumar', tier:'founding', qrMatrix:[[true]],
  });
  assert.match(svg, /Scan to connect privately with Vasanthkumar/);
  assert.match(svg, /vaultlix\.com\/2480599999/);
  assert.match(svg, /NO SIM REQUIRED/);
  assert.doesNotMatch(svg, /vaultlix\.com\/p-ABC234/);
  assert.doesNotMatch(svg, /Scan to extend a private line/);
});

test('native apps prepare the image before opening the system share sheet', () => {
  const android = readFileSync(join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
  const ios = readFileSync(join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
  assert.match(android, /boolean sharePreparedImage\(\)[\s\S]*Intent\.ACTION_SEND/);
  assert.match(android, /Intent\.EXTRA_TEXT, preparedNumberCardLink/);
  assert.match(ios, /action == "shareImage"[\s\S]*presentShareImage\(fileURL, shareURL: preparedShareLinkURL\)/);
  assert.match(ios, /func presentShareImage[\s\S]*UIActivityViewController/);
  assert.match(android, /setClipData\(ClipData\.newRawUri/);
  assert.match(android, /boolean prepareShareImage\(String dataUrl\)/);
  assert.match(android, /boolean sharePreparedImage\(\)/);
  assert.match(android, /boolean shareImage\(String dataUrl\)/);
  assert.match(android, /boolean shareImageWithLink\(String dataUrl, String shareUrl\)/);
  assert.match(ios, /action == "prepareShareImage"/);
  assert.match(ios, /action == "sharePreparedImage"/);
  assert.match(ios, /vaultlix:share-image-presented/);
  assert.match(client, /numberCardAssetPromise = prepareNumberCardAsset\(canvas\)/);
  assert.match(client, /prepareNativeNumberCard\(asset\.dataUrl, numberCardShareUrl\(state\.privateNumber\)\)/);
  assert.match(client, /VaultlixAndroid\.sharePreparedImage\(\)/);
  assert.doesNotMatch(client, /Card saved as an image|downloadDataUri\(asset\.dataUrl/);
  const shareFunction = client.match(/async function shareNumberCard\(\) \{[\s\S]*?\n\}/)?.[0] || '';
  assert.match(shareFunction, /text:`Connect with me privately on Vaultlix: \$\{shareUrl\}`/);
  assert.match(shareFunction, /url:shareUrl/);
  assert.match(shareFunction, /sharePreparedImage\(\) === true/);
  assert.doesNotMatch(shareFunction, /postMessage\(\{ action:'sharePreparedImage' \}\);\s*closeNumberCard\(\)/);
});
