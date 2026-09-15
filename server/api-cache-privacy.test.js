'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const server = readFileSync(join(__dirname, 'index.js'), 'utf8');

test('every API response is non-cacheable at the request boundary', () => {
  const boundary = "if (!u.pathname.startsWith('/api/')) { serveStatic(req,res); return; }";
  const noStore = "res.setHeader('Cache-Control', 'no-store');";
  assert.ok(server.indexOf(boundary) >= 0);
  assert.ok(server.indexOf(noStore, server.indexOf(boundary)) > server.indexOf(boundary));
});
