'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('Daily Look keeps provider credentials on the server and requires an authenticated account', () => {
  assert.match(server, /process\.env\.OPENAI_API_KEY/);
  assert.doesNotMatch(client, /OPENAI_API_KEY|api\.openai\.com/);
  assert.match(server, /path === '\/api\/account\/daily-look'[\s\S]{0,500}authenticateAccountSession/);
  assert.match(server, /https:\/\/api\.openai\.com\/v1\/images\/edits/);
  assert.match(server, /https:\/\/api\.openai\.com\/v1\/moderations/);
});

test('Daily Look allows one successful creation per 24 hours across Railway replicas', () => {
  assert.match(server, /const DAY_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(server, /claimDailyLook\(d\.accountId, account, now\)/);
  assert.match(server, /catch \(error\) \{[\s\S]{0,120}releaseDailyLookClaim/);
  assert.match(postgres, /daily_look_generated_at bigint/);
  assert.match(postgres, /daily_look_claimed_at bigint/);
  assert.match(postgres, /UPDATE accounts SET daily_look_claimed_at=\$2[\s\S]*RETURNING account_id/);
  assert.match(postgres, /completeDailyLook[\s\S]*daily_look_generated_at=\$2/);
});

test('Daily Look sends only an explicitly selected, reduced image and never stores the original', () => {
  assert.match(client, /id="daily-look-consent" type="checkbox"/);
  assert.match(client, /dailyLookSourceImage = await compressProfileImage\(file\)/);
  assert.match(client, /I agree to send this selected photo to OpenAI/);
  assert.match(server, /parseDailyLookImage\(d\.image\)/);
  assert.doesNotMatch(postgres, /daily_look_(?:source|input|original|image)\b/);
  assert.match(client, /Vaultlix does not keep the selected source photo/);
});

test('Daily Look offers curated rotating styles, profile use, and download', () => {
  assert.match(server, /id:'retro-80s', name:'1980s Film'/);
  assert.match(server, /Math\.floor\(now \/ \(7 \* DAY_MS\)\)/);
  assert.match(client, /Create today’s look/);
  assert.match(client, /function useDailyLookAsProfile\(\)/);
  assert.match(client, /saveProfileImageUpdate\('replace', image\)/);
  assert.match(client, /function downloadDailyLook\(\)/);
  assert.match(client, /downloadDataUri\(dailyLookGeneratedImage/);
});

