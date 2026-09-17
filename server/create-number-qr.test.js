'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const generator = fs.readFileSync(path.join(root, 'scripts', 'generate-create-number-qr.js'), 'utf8');
const svg = fs.readFileSync(path.join(root, 'client', 'media', 'vaultlix-create-number-qr.svg'), 'utf8');
const png = fs.readFileSync(path.join(root, 'client', 'media', 'vaultlix-create-number-qr.png'));

test('promotional QR card uses the Vaultlix brand and account-creation destination', () => {
  assert.match(generator, /TARGET_URL = 'https:\/\/vaultlix\.com\/\?create=1'/);
  assert.match(generator, /createQrMatrix\(TARGET_URL\)/);
  assert.match(svg, /width="1080" height="1350"/);
  assert.match(svg, /#6B1F3A/);
  assert.match(svg, /Create your Vaultlix number/);
  assert.match(svg, /SCAN TO CREATE/);
  assert.match(svg, /vaultlix\.com\/\?create=1/);
  assert.match(svg, /<path d="M[0-9]/);
});

test('promotional QR card includes a full-resolution shareable PNG', () => {
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), 1350);
});
