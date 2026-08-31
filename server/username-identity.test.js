'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('public username is separate from the private random account id', () => {
  assert.match(client, /function randomAccountId\(\)/);
  assert.doesNotMatch(client, /async function accountIdFor\(username\)/);
  assert.match(server, /const usernames = new Map\(\)/);
  assert.match(server, /version: 2, username, displayName/);
});

test('username profiles and authenticated connection requests are exposed', () => {
  assert.match(server, /path\.startsWith\('\/api\/profile\/'\)/);
  assert.match(server, /path === '\/api\/connections\/request'/);
  assert.match(server, /path === '\/api\/connections\/respond'/);
  assert.match(client, /Request a private vault/);
  assert.match(client, /Accept and create vault/);
});

test('vault setup uses the permanent identity name', () => {
  assert.match(client, /const name = identity\.displayName/);
  assert.match(client, /id="identity-name-field" style="display:none"/);
});

test('registration uses three system-generated six-character usernames', () => {
  assert.match(server, /const USERNAME_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'/);
  assert.match(server, /path === '\/api\/account\/username-options'/);
  assert.match(server, /options:generateUsernameOptions\(3\)/);
  assert.match(server, /\^\[a-z2-9\]\{6\}\$/);
  assert.match(client, /id="account-username-options"/);
  assert.match(client, /Choose your six-character username/);
  assert.match(client, /function selectUsernameOption/);
});
