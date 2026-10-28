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

test('Daily Look sends only an explicitly selected, reduced image, preserves its original dimensions, and never stores the source', () => {
  assert.match(client, /id="daily-look-consent" type="checkbox"/);
  assert.match(client, /const prepared = await prepareDailyLookImage\(file\)/);
  assert.match(client, /1600 \/ longestEdge/);
  assert.match(client, /result\.length <= 1200 \* 1024/);
  assert.match(client, /width:image\.naturalWidth, height:image\.naturalHeight/);
  assert.match(client, /sourceWidth:dailyLookSourceDimensions\?\.width, sourceHeight:dailyLookSourceDimensions\?\.height/);
  assert.match(server, /bytes\.length > 900 \* 1024/);
  assert.match(server, /dailyLookSourceDimensions\(image, Number\(d\.sourceWidth\), Number\(d\.sourceHeight\)\)/);
  assert.match(server, /dailyLookProviderSize\(sourceWidth, sourceHeight\)/);
  assert.match(server, /resize\(sourceWidth, sourceHeight, \{ fit:'cover', position:'centre' \}\)/);
  assert.match(client, /--daily-look-aspect/);
  assert.match(client, /I agree to send this selected photo to OpenAI/);
  assert.match(server, /parseDailyLookImage\(d\.image\)/);
  assert.doesNotMatch(postgres, /daily_look_(?:source|input|original|image)\b/);
  assert.match(client, /Vaultlix does not keep the selected source photo/);
});

test('Daily Look offers curated rotating styles, profile use, and download', () => {
  assert.match(server, /id:'surprise-enhancer', name:'Surprise Enhancer'/);
  assert.doesNotMatch(server, /navratri/i, 'the Navratri Special style has been retired');
  assert.match(server, /Math\.floor\(now \/ \(7 \* DAY_MS\)\)/);
  assert.match(client, /Create today’s look/);
  assert.match(client, /function useDailyLookAsProfile\(\)/);
  assert.match(client, /saveProfileImageUpdate\('replace', image\)/);
  assert.match(client, /function downloadDailyLook\(\)/);
  assert.match(client, /downloadDataUri\(dailyLookGeneratedImage/);
});

test('status creation can return a generated Daily Look into preview before audience selection', () => {
  assert.match(client, /onclick="openDailyLookForStatus\(\)">Create Today’s Look<\/button>/);
  assert.match(client, /function openDailyLookForStatus\(\)[\s\S]*openDailyLook\(\{ destination:'status' \}\)/);
  assert.match(client, /id="daily-look-use-status"[^>]*onclick="useDailyLookInStatus\(\)"[^>]*hidden/);
  assert.match(client, /async function useDailyLookInStatus\(\)[\s\S]*dailyLookProfileImage\(\)[\s\S]*statusComposerImage = image/);
  assert.doesNotMatch(client, /allowLocalImageSend|checkLocalImages|localImageSafetyEnabled/);
  assert.match(client, /statusComposerImage = image[\s\S]*status-image-preview[\s\S]*preview\.hidden = false/);
  assert.match(client, /dailyLookDestination === 'status'[\s\S]*status-composer/);
  assert.match(client, /id="status-compose-audience" hidden><h2>Select contacts<\/h2>/);
});

test('Daily Look uses the configured image model, provider size and per-style quality', () => {
  assert.match(server, /process\.env\.OPENAI_IMAGE_MODEL \|\| 'gpt-image-2\.5-sunburst'/);
  assert.match(server, /dailyLookProviderSize\(sourceWidth, sourceHeight\)/);
  assert.match(server, /style\.quality \|\| process\.env\.OPENAI_IMAGE_QUALITY \|\| 'medium'/);
  assert.match(client, /\.daily-look-preview\{[^}]*aspect-ratio:var\(--daily-look-aspect,1\)/);
});

test('Surprise Enhancer rotates source-aware transformations without repeating today', () => {
  assert.match(server, /id:'surprise-enhancer', name:'Surprise Enhancer'/);
  const lookBlock = server.match(/const ENHANCER_LOOKS = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] || '';
  const ids = [...lookBlock.matchAll(/id:'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, ['fix-lighting', 'caricature', 'studio-headshot', 'enhance-photo', 'mini-me', 'cinematic-anime']);
  assert.match(lookBlock, /close portrait[\s\S]*full-body[\s\S]*(?:couple|group)/);
  assert.match(server, /First inspect the source and identify whether it is a close portrait, half-body or full-body photograph, couple or group/);
  assert.match(server, /function dailyLookRotationItem\(items, variantIndex\)/);
  assert.match(server, /dailyLookRotationItem\(ENHANCER_LOOKS, variantIndex\)/);
  for (let start = 0; start < ids.length; start++) {
    const today = Array.from({ length:5 }, (_, offset) => ids[(start + offset) % ids.length]);
    assert.equal(new Set(today).size, 5);
  }
  assert.match(server, /premium hand-drawn cinematic anime interpretation/);
  assert.match(server, /never making the person younger/);
  assert.match(lookBlock, /In a gym or fitness room[\s\S]*preserve the gym, mirrors, machines, benches and weights exactly/);
  assert.match(lookBlock, /Preserve the exact pixel-space geometry of every person/);
  assert.match(server, /The input photograph is authoritative for identity/);
  assert.match(server, /For Fix Lighting and Enhance Photo, treat this as a restrained edit of the original pixels/);
  assert.match(server, /face outline, forehead, hairline, eyebrow shape, eye shape and spacing/);
  assert.doesNotMatch(server, /id:'neon-night'|id:'anime-portrait'/);
});

test('the per-account rotation seed is unbounded and applied by modulo at the style collection', () => {
  assert.match(server, /function dailyLookVariantIndex\(accountId, generationCount, now = Date\.now\(\)\)/);
  assert.match(server, /return seed \+ Math\.max\(0, Number\(generationCount\) \|\| 0\)/);
  assert.match(server, /dailyLookVariantIndex\(d\.accountId, usage\.count, now\)/);
});

test('Android Daily Look offers a dedicated camera capture path', () => {
  assert.match(client, /id="daily-look-camera-input"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(client, /id="daily-look-camera-button"[^>]*onclick="chooseDailyLookCamera\(\)"/);
  assert.match(client, /\.vaultlix-native-android \.daily-look-camera-button\{display:block\}/);
  assert.match(client, /function chooseDailyLookCamera\(\)/);
});

test('Daily Look opens fresh instead of restoring the previous generated preview', () => {
  assert.match(client, /const DAILY_LOOK_RESULT_DB = 'vaultlix-daily-look'/);
  assert.match(client, /indexedDB\.open\(DAILY_LOOK_RESULT_DB, 1\)/);
  assert.match(client, /saveDailyLookResult\(savedLook\.accountId, savedLook\.image/);
  const openStart = client.indexOf('async function openDailyLook(');
  const openEnd = client.indexOf('function chooseDailyLookPhoto(', openStart);
  const open = client.slice(openStart, openEnd);
  assert.doesNotMatch(open, /loadDailyLookResult\(/);
  assert.doesNotMatch(open, /showDailyLookResult\(/);
  assert.match(client, /onclick="downloadDailyLook\(\)"/);
  assert.match(client, /onclick="beginAnotherDailyLook\(\)"/);
  assert.match(client, /function downloadDailyLook\(\)[\s\S]{0,220}downloadDataUri\(dailyLookGeneratedImage/);
  assert.match(client, /function downloadDataUri\(dataUri, filename\)[\s\S]{0,120}transferDataUri\(dataUri, filename, 'save'\)/);
  assert.match(client, /VaultlixAndroid\.saveMedia\(dataUri, filename \|\| 'vaultlix-file'\)/);
  assert.match(client, /indexedDB\.deleteDatabase\(DAILY_LOOK_RESULT_DB\)/);
});

test('finished Daily Look images are returned and saved without a Vaultlix watermark', () => {
  assert.match(server, /Do not generate any text, logo or watermark/);
  assert.match(server, /return `data:image\/jpeg;base64,\$\{output\.toString\('base64'\)\}`/);
  assert.doesNotMatch(server, /watermarkDailyLookOutput|DAILY_LOOK_WATERMARK_VERSION|watermarkVersion:/);
  assert.doesNotMatch(client, /watermarkDailyLookImage|DAILY_LOOK_WATERMARK_VERSION|Adding the Vaultlix signature/);
  assert.match(client, /image:result\.generatedImage/);
});

test('device profile selection saves through existing checks without generating a Daily Look', async()=>{
  const vm=require('node:vm');
  const start=client.indexOf('async function handleDailyLookProfilePhoto(');
  const end=client.indexOf('async function handleDailyLookPhoto(',start);
  const events=[],status={};
  const context={document:{getElementById:()=>status},compressProfileImage:async()=>{events.push('prepare');return 'photo';},saveProfileImageUpdate:async(action,image)=>{events.push([action,image]);return true;},closeDailyLook:()=>events.push('closed'),toast:()=>{}};
  vm.createContext(context);vm.runInContext(client.slice(start,end),context);
  await context.handleDailyLookProfilePhoto({target:{files:[]}});assert.equal(events.length,0);
  const event={target:{files:[{}],value:'selected'}};
  await context.handleDailyLookProfilePhoto(event);
  assert.deepEqual(events,['prepare',['replace','photo'],'closed']);assert.equal(event.target.value,'');
  events.length=0;context.saveProfileImageUpdate=async()=>false;
  await context.handleDailyLookProfilePhoto(event);assert.deepEqual(events,['prepare']);assert.match(status.textContent,/not saved/);
});
