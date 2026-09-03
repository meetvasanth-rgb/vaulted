'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('KLIPY uses a direct-client picker and encrypted GIF message references', () => {
  assert.match(client, /placeholder="Search KLIPY"/);
  assert.match(client, /fetch\(`https:\/\/api\.klipy\.com\/v2\/search\?\$\{params\}`\)/);
  assert.match(client, /type:'klipy-gif'/);
  assert.match(client, /encryptTextMsg\(room, payload\)/);
  assert.match(client, /v2\/registershare/);
});

test('KLIPY media is restricted to approved HTTPS delivery hosts', () => {
  assert.match(client, /url\.protocol === 'https:'/);
  assert.match(client, /\['static\.klipy\.com', 'static1\.klipy\.com', 'static2\.klipy\.com'\]/);
  assert.match(client, /Vaultlix does not send your private number to KLIPY/);
  assert.doesNotMatch(client, /\/api\/klipy|proxyKlipy|cacheKlipy/);
});

test('conversation opening defers offscreen KLIPY animation until after first paint', () => {
  assert.match(client, /data-klipy-src=/);
  assert.match(client, /decoding="async"/);
  assert.match(client, /fetchpriority="low"/);
  assert.match(client, /requestAnimationFrame\(\(\) => requestAnimationFrame/);
  assert.match(client, /new IntersectionObserver/);
  assert.match(client, /rootMargin:'320px 0px'/);
});
