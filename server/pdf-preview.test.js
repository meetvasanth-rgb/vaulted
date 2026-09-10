'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('PDF previews render only on-device and travel inside the encrypted file payload', () => {
  assert.match(client, /import\('\/vendor\/pdf\.min\.mjs'\)/);
  assert.match(client, /getDocument\(\{ data:bytes, isEvalSupported:false \}\)/);
  assert.match(client, /pdfPreview, pageCount:Number\(pageCount\)/);
  assert.match(client, /safeImageDataUri\('image\/jpeg', parsed\.pdfPreview\)/);
  assert.doesNotMatch(client, /cdnjs|unpkg|jsdelivr/);
});

test('the pinned PDF renderer and worker are served from Vaultlix itself', () => {
  assert.match(server, /url === '\/vendor\/pdf\.min\.mjs'/);
  assert.match(server, /pdfjs-dist\/build\/pdf\.worker\.min\.mjs/);
  assert.match(server, /'\.mjs':'text\/javascript'/);
});
