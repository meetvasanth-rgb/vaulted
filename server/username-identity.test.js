'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('public Private Number is separate from the private random account id', () => {
  assert.match(client, /function randomAccountId\(\)/);
  assert.match(server, /const privateNumbers = new Map\(\)/);
  assert.match(server, /version: 2, privateNumber, displayName/);
  assert.match(server, /function generatePrivateNumber\(\)/);
  assert.match(server, /\^\[2-9\]\[0-9\]\{9\}\$/);
});

test('Private Number profiles and authenticated connection requests are exposed', () => {
  assert.match(server, /path\.startsWith\('\/api\/profile\/'\)/);
  assert.match(server, /path === '\/api\/connections\/request'/);
  assert.match(server, /path === '\/api\/connections\/respond'/);
  assert.match(client, /Request a private vault/);
  assert.match(client, /Accept connection/);
});

test('accepted connections retain the peer Private Number inside conversation details', () => {
  assert.match(client, /pendingConnectionPeerPrivateNumber = normalizePrivateNumber\(request\?\.senderPrivateNumber\)/);
  assert.match(client, /pendingJoinPeerPrivateNumber = normalizePrivateNumber\(accepted\.recipientPrivateNumber\)/);
  assert.match(client, /peerPrivateNumber: room\.peerPrivateNumber \|\| null/);
  assert.match(client, /peerPrivateNumber:session\.peerPrivateNumber/);
  assert.match(client, /id="conversation-profile-private-number"/);
  assert.match(client, /Copy private number/);
  assert.match(client, /Share private number/);
  assert.match(client, /Save both your private number and recovery code\./);
});

test('vault setup uses the permanent identity name', () => {
  assert.match(client, /const name = identity\.displayName/);
  assert.match(client, /id="identity-name-field" style="display:none"/);
});

test('registration uses a system-generated ten-digit Private Number', () => {
  assert.match(server, /path === '\/api\/account\/private-number'/);
  assert.match(server, /privateNumber:generatePrivateNumber\(\)/);
  assert.match(server, /privateNumbers\.has\(privateNumber\)/);
  assert.match(client, /id="account-private-number-value"/);
  assert.match(client, /function generatePrivateNumber\(\)/);
  assert.match(client, /Generation limit reached\. Try again in about one hour\./);
  assert.match(client, /Password policy:<\/strong> Minimum 8 characters/);
  assert.match(client, /password\.length < 8/);
  assert.match(client, /This is not a cellular phone number/);
  assert.match(client, /vaultlix\.com\/\$\{result\.profile\.privateNumber\}/);
});
