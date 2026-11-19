'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'index.js'), 'utf8');

test('a fresh device bootstrap is bounded and later restores use the normal delta cursor', () => {
  const poll = server.slice(server.indexOf("if (path==='/api/poll' && method==='POST')"), server.indexOf("if (path==='/api/history'"));
  assert.match(poll, /const bootstrapLimit = includeOwn\s*\? Math\.max\(1, Math\.min\(100, parseInt\(d\.bootstrapLimit, 10\) \|\| 50\)\)/);
  assert.match(poll, /if \(includeOwn && newMsgs\.length > bootstrapLimit\) newMsgs = newMsgs\.slice\(-bootstrapLimit\);/);
});
