'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('temporary object-storage failure does not abort Vaultlix startup', () => {
  const helperStart = server.indexOf('async function enableObjectStorage()');
  const bootstrapStart = server.indexOf('async function bootstrap()');
  assert.ok(helperStart > -1);
  assert.ok(bootstrapStart > helperStart);

  const helper = server.slice(helperStart, bootstrapStart);
  assert.match(helper, /catch \(error\)[\s\S]*objectStorageEnabled = false/);
  assert.match(helper, /messaging and calls remain online while Vaultlix retries/);
  assert.match(helper, /setInterval\([\s\S]*30 \* 1000/);

  const bootstrap = server.slice(bootstrapStart, server.indexOf('bootstrap().catch'));
  assert.match(bootstrap, /if \(objectStorage\.enabled\) \{\s*await enableObjectStorage\(\);\s*\}/);
  assert.doesNotMatch(bootstrap, /await objectStorage\.initialize\(\)/);
});
