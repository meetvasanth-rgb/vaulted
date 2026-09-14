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

test('Daily Look allows five successful creations and resets at midnight IST across replicas', () => {
  assert.match(server, /const DAILY_LOOK_DAILY_LIMIT = 5/);
  assert.match(server, /DAILY_LOOK_RESET_OFFSET_MINUTES/);
  assert.match(server, /configured >= -720 && configured <= 840 \? configured : 330/);
  assert.match(server, /function dailyLookDayWindow\(now = Date\.now\(\)\)/);
  assert.match(server, /Math\.floor\(\(now \+ offsetMs\) \/ DAY_MS\) \* DAY_MS - offsetMs/);
  assert.match(server, /windowStartedAt === dayWindow\.startedAt/);
  assert.match(server, /dayWindow\.nextAt/);
  assert.match(server, /dailyLookUsage\(account/);
  assert.match(server, /claimDailyLook\(d\.accountId, account, now\)/);
  assert.match(server, /catch \(error\) \{[\s\S]{0,120}releaseDailyLookClaim/);
  assert.match(postgres, /daily_look_generated_at bigint/);
  assert.match(postgres, /daily_look_claimed_at bigint/);
  assert.match(postgres, /daily_look_window_started_at bigint/);
  assert.match(postgres, /daily_look_generation_count integer NOT NULL DEFAULT 0/);
  assert.match(postgres, /UPDATE accounts SET daily_look_claimed_at=\$2[\s\S]*RETURNING account_id/);
  assert.match(postgres, /daily_look_window_started_at <> \$3/);
  assert.match(postgres, /completeDailyLook[\s\S]*daily_look_generation_count=CASE/);
  assert.match(client, /up to \$\{result\.limit \|\| 5\} creations daily/);
});

test('Daily Look sends only an explicitly selected, reduced image and never stores the original', () => {
  assert.match(client, /id="daily-look-consent" type="checkbox"/);
  assert.match(client, /dailyLookSourceImage = await prepareDailyLookImage\(file\)/);
  assert.match(client, /1600 \/ longestEdge/);
  assert.match(client, /result\.length <= 1200 \* 1024/);
  assert.match(server, /bytes\.length > 900 \* 1024/);
  assert.match(client, /I agree to send this selected photo to OpenAI/);
  assert.match(server, /parseDailyLookImage\(d\.image\)/);
  assert.doesNotMatch(postgres, /daily_look_(?:source|input|original|image)\b/);
  assert.match(client, /Vaultlix does not keep the selected source photo/);
});

test('Daily Look offers curated rotating styles, profile use, and download', () => {
  assert.match(server, /id:'vinayagar-80s', name:'1980s Vinayagar Chaturthi'/);
  assert.match(server, /Math\.floor\(now \/ \(7 \* DAY_MS\)\)/);
  assert.match(client, /Create today’s look/);
  assert.match(client, /function useDailyLookAsProfile\(\)/);
  assert.match(client, /saveProfileImageUpdate\('replace', image\)/);
  assert.match(client, /function downloadDailyLook\(\)/);
  assert.match(client, /downloadDataUri\(dailyLookGeneratedImage/);
});

test('1980s Vinayagar Chaturthi creates a high-quality profile-ready period portrait', () => {
  assert.match(server, /Vinayagar Chaturthi portrait photographed in Tamil Nadu during the mid-1980s/);
  assert.match(server, /do not make a modern scene with a retro filter/);
  assert.match(server, /process\.env\.OPENAI_IMAGE_MODEL \|\| 'gpt-image-2\.5-sunburst'/);
  assert.match(server, /head-and-shoulders or chest-up portrait/);
  assert.match(server, /Do not make the person full-length/);
  assert.match(server, /Preserve bright eyes, healthy youthful skin/);
  assert.match(server, /selected 1980s festival scenario below is mandatory/);
  assert.match(server, /never place the subject in the role of a deity/);
  assert.match(server, /Do not add extra limbs, fingers, hands, faces/);
  assert.match(server, /The face and background must share the same light direction, colour temperature, exposure, shadow softness/);
  assert.match(server, /Do not use an independent portrait key light/);
  assert.match(server, /without scratches, date stamps, heavy fading or ageing the face/);
  assert.match(server, /size:'1024x1024'/);
  assert.match(server, /form\.append\('size', style\.size \|\| '1024x1024'\)/);
  assert.match(server, /quality:'high'/);
  assert.match(server, /style\.quality \|\| process\.env\.OPENAI_IMAGE_QUALITY \|\| 'medium'/);
  assert.match(client, /\.daily-look-preview\{[^}]*aspect-ratio:1/);
});

test('Daily Look replaces Editorial Glow with an identity-preserving anime portrait', () => {
  assert.match(server, /id:'anime-portrait', name:'Anime Portrait'/);
  assert.match(server, /premium hand-drawn cinematic anime portrait/);
  assert.match(server, /Do not replace them with a generic character/);
  assert.match(server, /likeness stronger than the stylisation/);
  assert.doesNotMatch(server, /id:'editorial-glow'/);
});

test('1980s Vinayagar Chaturthi rotates through five lighting-matched festival scenarios per account', () => {
  const lookBlock = server.match(/const VINAYAGAR_80S_LOOKS = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] || '';
  assert.equal((lookBlock.match(/^  '/gm) || []).length, 5);
  assert.match(lookBlock, /Tamil home puja at dawn/);
  assert.match(lookBlock, /temple-courtyard darshan in the morning/);
  assert.match(lookBlock, /neighbourhood pandal in the afternoon/);
  assert.match(lookBlock, /kozhukattai preparation at home/);
  assert.match(lookBlock, /Vinayagar procession at blue hour/);
  assert.doesNotMatch(lookBlock, /Devotional close-up wish|Premium festive pandal wish|Modern minimal blessing card/);
  assert.match(server, /function dailyLookVariantIndex\(accountId, generationCount, now = Date\.now\(\)\)/);
  assert.match(server, /seed \+ Math\.max\(0, Number\(generationCount\) \|\| 0\)/);
  assert.match(server, /VINAYAGAR_80S_LOOKS\[variantIndex % VINAYAGAR_80S_LOOKS\.length\]/);
  assert.match(server, /dailyLookVariantIndex\(d\.accountId, usage\.count, now\)/);
  assert.match(server, /Selected 1980s Vinayagar Chaturthi scenario for this generation/);
});

test('Android Daily Look offers a dedicated camera capture path', () => {
  assert.match(client, /id="daily-look-camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(client, /id="daily-look-camera-button"[^>]*onclick="chooseDailyLookCamera\(\)"/);
  assert.match(client, /\.vaultlix-native-android \.daily-look-camera-button\{display:block\}/);
  assert.match(client, /function chooseDailyLookCamera\(\)/);
});

test('the latest generated Daily Look remains downloadable after profile use and reopening', () => {
  assert.match(client, /const DAILY_LOOK_RESULT_DB = 'vaultlix-daily-look'/);
  assert.match(client, /indexedDB\.open\(DAILY_LOOK_RESULT_DB, 1\)/);
  assert.match(client, /saveDailyLookResult\(savedLook\.accountId, savedLook\.image/);
  assert.match(client, /loadDailyLookResult\(state\.accountId\)/);
  assert.match(client, /Your last Daily Look is saved on this device and ready to download/);
  assert.match(client, /onclick="downloadDailyLook\(\)"/);
  assert.match(client, /onclick="beginAnotherDailyLook\(\)"/);
  assert.match(client, /indexedDB\.deleteDatabase\(DAILY_LOOK_RESULT_DB\)/);
});
