'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const iosLinks = fs.readFileSync(path.join(root, 'mobile/ios/App/Shared/InviteLink.swift'), 'utf8');
const iosAssociation = fs.readFileSync(path.join(root, 'client/.well-known/apple-app-site-association'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');

function extract(name, keyword = 'function') {
  const start = client.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('Share invitation creates a private invite URL instead of sharing the permanent number URL', () => {
  assert.match(server, /PRIVATE_INVITE_TTL_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(server, /path === '\/api\/private-invites\/create'/);
  assert.match(server, /url:`https:\/\/vaultlix\.com\/invite\/\$\{code\}`/);
  assert.match(extract('shareFirstConnectionInvite', 'async function'), /await createPrivateInvitation\(state\)/);
  assert.match(extract('shareInviteFromCard', 'async function'), /await createPrivateInvitation\(state\)/);
  assert.doesNotMatch(extract('inviteShareText'), /state\.privateNumber/);
});

test('private invitation paths are recognized by the page and both native apps', () => {
  const context = vm.createContext({ String, normalizeProfileShareCode:value => /^[A-HJ-NP-Z2-9]{6}$/.test(String(value).toUpperCase()) ? String(value).toUpperCase() : '' });
  vm.runInContext(extract('parsePrivateInviteCode'), context);
  assert.equal(vm.runInContext("parsePrivateInviteCode('/invite/K6AKTD')", context), 'K6AKTD');
  assert.equal(vm.runInContext("parsePrivateInviteCode('/invite/K6AKTD7')", context), null);
  assert.match(iosLinks, /path\.hasPrefix\("\/invite\/"\)/);
  assert.match(iosAssociation, /"\/invite\/\*"/);
  assert.match(android, /\/invite\/\[A-HJ-NP-Za-hj-np-z2-9\]\{6\}/);
});

test('redeeming is one-time and reverses consent so the recipient can create the room immediately', () => {
  assert.match(server, /path === '\/api\/private-invites\/redeem'/);
  assert.match(server, /found\.invite\.usedAt = now/);
  assert.match(server, /privateInviteCodes\.delete\(found\.invite\.code\)/);
  assert.match(server, /const liveFound = accountByPrivateInviteCode\(d\.inviteCode\)/);
  assert.match(server, /senderAccountId:found\.accountId/);
  assert.match(server, /recipientAccountId:d\.accountId/);
  assert.match(server, /direction:'incoming'/);
  const redeem = extract('redeemPrivateInvitation', 'async function');
  assert.match(redeem, /await acceptConnectionRequest\(result\.request\.id\)/);
  assert.doesNotMatch(redeem, /promptRequestMessage/);
});

test('the permanent number and profile links keep the ordinary request flow', () => {
  assert.match(extract('requestPrivateVault', 'async function'), /api\('\/api\/connections\/request'/);
  assert.match(client, /activePublicProfile\.privateInvitation && await redeemPrivateInvitation\(state\)/);
  assert.match(server, /path\.startsWith\('\/api\/profile\/'\)/);
});
