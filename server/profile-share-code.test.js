'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');
const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
const worker = readFileSync(join(__dirname, '..', 'client', 'sw.js'), 'utf8');
const appleAssociation = readFileSync(join(__dirname, '..', 'client', '.well-known', 'apple-app-site-association'), 'utf8');

test('profile cards use a server-issued six-character link instead of exposing the Private Number in the URL', () => {
  assert.match(server, /PROFILE_SHARE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'/);
  assert.match(server, /address:`https:\/\/vaultlix\.com\/p\/\$\{account\.profileShareCode\}`/);
  assert.match(server, /path\.startsWith\('\/api\/profile-share\/'\)/);
  assert.match(client, /https:\/\/vaultlix\.com\/p\/\$\{code\}\?ref=qr/);
  assert.match(client, /openPublicProfileShareCode\(publicProfileShareCode\)/);
  assert.ok(worker.includes("/^\\/p\\/[a-hj-np-z2-9]{6}\\/?$/i.test(pathname)"));
  assert.match(appleAssociation, /"\/p\/\*"/);
});
