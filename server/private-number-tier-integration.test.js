'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { SCHEMA_SQL } = require('./postgres');

const server = readFileSync(join(__dirname, 'index.js'), 'utf8');
const client = readFileSync(join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('account schema persists tier, founding status, and creation order', () => {
  assert.match(SCHEMA_SQL, /tier varchar\(16\).*'standard'.*'reserve'.*'founding'/s);
  assert.match(SCHEMA_SQL, /is_founding boolean NOT NULL DEFAULT false/);
  assert.match(SCHEMA_SQL, /creation_order bigint NOT NULL DEFAULT nextval/);
  assert.match(server, /tier:account\.tier/);
  assert.match(server, /isFounding:!!account\.isFounding/);
  assert.match(server, /revision: account\.revision, \.\.\.publicAccount\(account\)/);
});

test('profile discovery is device-scoped, capped at ten per hour, and backs off', () => {
  assert.match(server, /function profileLookupRetryAfter/);
  assert.match(server, /bucket\.count <= 10/);
  assert.match(server, /2 \*\* Math\.min\(bucket\.count - 11, 12\)/);
  assert.match(server, /'Retry-After'/);
  assert.match(client, /'X-Vaultlix-Lookup-Key':privateLookupKey\(\)/);
  assert.doesNotMatch(server, /profileLookupBuckets\.set\([^\n]*privateNumber/);
});

test('launch-period generation exposes server-gated Reserve choices', () => {
  assert.match(server, /RESERVE_CATEGORIES\.includes\(requestedCategory\)/);
  assert.match(server, /category !== NUMBER_TIERS\.STANDARD && !earlyTester/);
  assert.match(client, /selectPrivateNumberCategory\('(zeros|sequence|repeated|pairs)'\)/);
});
