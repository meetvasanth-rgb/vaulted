'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('profile images are authenticated, bounded and persisted', () => {
  assert.match(server, /function normalizeProfileImage\(value\)/);
  assert.match(server, /decodedBytes > 0 && decodedBytes <= 128 \* 1024/);
  assert.match(server, /const BODY_LIMIT_PROFILE = 192 \* 1024/);
  assert.match(server, /pathname === '\/api\/account\/profile'\) return BODY_LIMIT_PROFILE/);
  assert.match(server, /path === '\/api\/account\/profile'[\s\S]*authenticateAccountSession/);
  assert.match(server, /d\.profileImageAction === 'replace'/);
  assert.match(server, /d\.profileImageAction === 'remove'/);
  assert.match(server, /profileImage:normalizeProfileImage\(account\.profileImage\) \|\| null/);
  assert.match(postgres, /profile_image text/);
  assert.match(postgres, /profile_image=EXCLUDED\.profile_image/);
});

test('profile images propagate through existing consent connections', () => {
  assert.match(server, /senderProfileImage:normalizeProfileImage\(accounts\.get\(senderAccountId\)\?\.profileImage\) \|\| null/);
  assert.match(server, /recipientProfileImage:normalizeProfileImage\(accounts\.get\(recipientAccountId\)\?\.profileImage\) \|\| null/);
  assert.doesNotMatch(server, /const request = \{[^\n]*senderProfileImage/);
  assert.match(client, /function peerIdentityFromConnection[\s\S]*senderProfileImage/);
  assert.match(client, /peerProfileImage: room\.peerProfileImage \|\| null/);
  assert.match(client, /class="profile-image-avatar"/);
});

test('profile image controls support add, replace and remove', () => {
  assert.match(client, /id="account-profile-photo-input"[^>]*accept="image\/\*,\.heic,\.heif"/);
  assert.match(client, /function chooseProfileImage\(\)/);
  assert.match(client, /async function compressProfileImage\(file\)/);
  assert.match(client, /jpe\?g\|png\|webp\|heic\|heif/);
  assert.match(client, /canvas\.width = 320; canvas\.height = 320/);
  assert.match(client, /saveProfileImageUpdate\('replace', image\)/);
  assert.match(client, /saveProfileImageUpdate\('remove'\)/);
  assert.match(client, /id="public-profile-photo"/);
});

test('privacy copy discloses optional profile image storage and visibility', () => {
  assert.match(client, /Adding a profile image is optional\./);
  assert.match(client, /shown to people who use your exact Private Number or connect with you/);
});
