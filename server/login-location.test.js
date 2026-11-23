'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loginLocation } = require('./login-location');
const { PostgresStore, SCHEMA_SQL } = require('./postgres');

test('local lookup retains only approximate place, time and platform', () => {
  let lookedUp;
  const result = loginLocation('::ffff:8.8.8.8', 'Mozilla/5.0 (iPhone) VaultlixNative', ip => {
    lookedUp = ip;
    return { city:'Example', region:'CA', country:'US', ll:[1,2], timezone:'secret', range:[1,2] };
  });
  assert.equal(lookedUp, '8.8.8.8');
  assert.deepEqual(Object.keys(result).sort(), ['at','platform','city','region','country','approximate'].sort());
  assert.equal(result.platform, 'ios');
  assert.equal(result.city, 'Example');
  assert.equal(result.approximate, true);
  assert.ok(result.at <= Date.now());
});

test('missing IP, private address, unavailable database and IPv6 are safe', () => {
  assert.equal(loginLocation('invalid', '', () => { throw Error('must not run'); }).country, null);
  assert.equal(loginLocation('127.0.0.1', '').country, null);
  assert.equal(loginLocation('8.8.8.8', '', () => { throw Error('missing database'); }).country, null);
  let seen;
  loginLocation('2001:4860:4860::8888', '', ip => { seen = ip; return null; });
  assert.equal(seen, '2001:4860:4860::8888');
});

test('latest login persists in the PostgreSQL account record and reloads', async () => {
  const calls = [];
  const lastLogin = loginLocation('8.8.8.8', '', () => ({country:'US'}));
  const pool = {query:async (sql, values) => {
    calls.push({sql, values});
    return {rows:sql === 'SELECT * FROM accounts ORDER BY created_at' ? [{account_id:'a', last_login:lastLogin}] : []};
  }};
  const store = new PostgresStore('', {pool});
  await store.saveAccount('a', {createdAt:1,updatedAt:1,lastLogin});
  const insert = calls.find(call => /INSERT INTO accounts/.test(call.sql));
  assert.match(SCHEMA_SQL, /ADD COLUMN IF NOT EXISTS last_login jsonb/);
  assert.match(insert.sql, /last_login=EXCLUDED.last_login/);
  assert.deepEqual(JSON.parse(insert.values[35]), lastLogin);
  const loaded = await store.loadAccounts();
  assert.deepEqual(loaded[0][1].lastLogin, lastLogin);
});
