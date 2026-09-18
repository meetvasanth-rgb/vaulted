'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const postgres = fs.readFileSync(path.join(__dirname, 'postgres.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const watermarkSource = fs.readFileSync(path.join(__dirname, 'daily-look-watermark.js'), 'utf8');
const sharp = require('sharp');
const { watermarkDailyLookOutput } = require('./daily-look-watermark');

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
  assert.match(server, /id:'retro-80s', name:'1980s Portrait'/);
  assert.match(server, /Math\.floor\(now \/ \(7 \* DAY_MS\)\)/);
  assert.match(client, /Create today’s look/);
  assert.match(client, /function useDailyLookAsProfile\(\)/);
  assert.match(client, /saveProfileImageUpdate\('replace', image\)/);
  assert.match(client, /function downloadDailyLook\(\)/);
  assert.match(client, /downloadDataUri\(dailyLookGeneratedImage/);
});

test('1980s Portrait creates a high-quality profile-ready period portrait', () => {
  assert.match(server, /Indian cinema portrait photographed in the mid-1980s/);
  assert.match(server, /do not make a modern scene with a retro filter/);
  assert.match(server, /process\.env\.OPENAI_IMAGE_MODEL \|\| 'gpt-image-2\.5-sunburst'/);
  assert.match(server, /uploaded photograph is an identity reference only/);
  assert.match(server, /taken by another person using an era-correct handheld or studio 35mm camera/);
  assert.match(server, /exact camera height, focal-length perspective, distance and framing/);
  assert.match(server, /Never create a selfie, phone-camera perspective, outstretched camera arm/);
  assert.match(server, /natural proportions between the head, neck, shoulders, torso and hands/);
  assert.match(server, /Do not crop through the chin or forehead/);
  assert.match(server, /Preserve bright eyes, healthy youthful skin/);
  assert.match(server, /selected 1980s shot brief below is mandatory/);
  assert.match(server, /pose, body angle, gaze, hand placement, camera height, lens perspective/);
  assert.match(server, /Do not add extra limbs, fingers, hands, faces/);
  assert.match(server, /The face and background must share the same light direction, colour temperature, exposure, shadow softness/);
  assert.match(server, /Do not use an independent portrait key light/);
  assert.match(server, /Do not age the person/);
  assert.match(server, /size:'1024x1024'/);
  assert.match(server, /form\.append\('size', style\.size \|\| '1024x1024'\)/);
  assert.match(server, /quality:'high'/);
  assert.match(server, /style\.quality \|\| process\.env\.OPENAI_IMAGE_QUALITY \|\| 'medium'/);
  assert.match(client, /\.daily-look-preview\{[^}]*aspect-ratio:1/);
});

test('Surprise Enhancer rotates source-aware transformations without repeating today', () => {
  assert.match(server, /id:'surprise-enhancer', name:'Surprise Enhancer'/);
  const lookBlock = server.match(/const ENHANCER_LOOKS = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] || '';
  const ids = [...lookBlock.matchAll(/id:'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, ['fix-lighting', 'caricature', 'studio-headshot', 'enhance-photo', 'mini-me', 'cinematic-anime']);
  assert.match(lookBlock, /close portrait[\s\S]*full-body[\s\S]*(?:couple|group)/);
  assert.match(server, /First inspect the source and respect whether it is a close portrait, half-body or full-body photograph, couple or group/);
  assert.match(server, /function dailyLookRotationItem\(items, variantIndex\)/);
  assert.match(server, /dailyLookRotationItem\(ENHANCER_LOOKS, variantIndex\)/);
  for (let start = 0; start < ids.length; start++) {
    const today = Array.from({ length:5 }, (_, offset) => ids[(start + offset) % ids.length]);
    assert.equal(new Set(today).size, 5);
  }
  assert.match(server, /premium hand-drawn cinematic anime interpretation/);
  assert.match(server, /never making the person younger/);
  assert.doesNotMatch(server, /id:'neon-night'|id:'anime-portrait'/);
});

test('1980s Portrait rotates through ten fully directed cinematic shot briefs per account', () => {
  const lookBlock = server.match(/const RETRO_80S_LOOKS = Object\.freeze\(\[([\s\S]*?)\n\]\);/)?.[1] || '';
  assert.equal((lookBlock.match(/^    id:/gm) || []).length, 10);
  assert.match(lookBlock, /Classic heroine publicity portrait/);
  assert.match(lookBlock, /Classic hero publicity portrait/);
  assert.match(lookBlock, /Disco-era star portrait/);
  assert.match(lookBlock, /Indian film-magazine publicity portrait/);
  assert.match(lookBlock, /Bollywood-star wedding-album portrait/);
  assert.match(lookBlock, /Bollywood star-at-home candid portrait/);
  assert.match(lookBlock, /Candid behind-the-scenes film-star portrait/);
  assert.match(lookBlock, /Bouffant heroine-inspired portrait/);
  assert.match(lookBlock, /Kurta-and-flares hero-inspired portrait/);
  assert.match(lookBlock, /Solo hand-painted cinema-poster portrait/);
  assert.equal((lookBlock.match(/pose:'/g) || []).length, 10);
  assert.equal((lookBlock.match(/camera:'/g) || []).length, 10);
  assert.equal((lookBlock.match(/framing:'/g) || []).length, 10);
  assert.equal((lookBlock.match(/setting:'/g) || []).length, 10);
  assert.equal((lookBlock.match(/lighting:'/g) || []).length, 10);
  assert.doesNotMatch(lookBlock, /Vinayagar|Ganesh|murti|pandal|visarjan|kozhukattai/);
  assert.match(server, /function dailyLookVariantIndex\(accountId, generationCount, now = Date\.now\(\)\)/);
  assert.match(server, /return seed \+ Math\.max\(0, Number\(generationCount\) \|\| 0\)/);
  assert.match(server, /dailyLookRotationItem\(RETRO_80S_LOOKS, variantIndex\)/);
  assert.match(server, /function retro80sShotBrief\(look\)/);
  assert.match(server, /Prescribed pose:/);
  assert.match(server, /Camera angle and lens:/);
  assert.match(server, /Required framing:/);
  assert.match(server, /Period setting:/);
  assert.match(server, /Integrated lighting:/);
  assert.match(server, /dailyLookVariantIndex\(d\.accountId, usage\.count, now\)/);
  assert.match(server, /Selected 1980s shot brief for this generation/);
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
  assert.match(client, /function downloadDailyLook\(\)[\s\S]{0,220}downloadDataUri\(dailyLookGeneratedImage/);
  assert.match(client, /function downloadDataUri\(dataUri, filename\)[\s\S]{0,120}transferDataUri\(dataUri, filename, 'save'\)/);
  assert.match(client, /VaultlixAndroid\.saveMedia\(dataUri, filename \|\| 'vaultlix-file'\)/);
  assert.match(client, /indexedDB\.deleteDatabase\(DAILY_LOOK_RESULT_DB\)/);
});

test('every finished Daily Look receives a subtle deterministic Vaultlix watermark', async () => {
  assert.match(server, /keep the lower-right edge visually calm and free of the subject's face, hands and important details/);
  assert.match(server, /Do not generate any text, logo or watermark yourself/);
  assert.match(client, /const DAILY_LOOK_WATERMARK_VERSION = 1/);
  assert.match(server, /watermarkDailyLookOutput\(Buffer\.from\(base64, 'base64'\)\)/);
  assert.match(server, /watermarkVersion:DAILY_LOOK_WATERMARK_VERSION/);
  assert.match(watermarkSource, /const sharp = require\('sharp'\)/);
  assert.match(watermarkSource, /\.composite\(\[\{ input:badge, left, top \}\]\)/);
  assert.match(watermarkSource, /Draw the wordmark as paths, never as a font-backed text element/);
  assert.match(watermarkSource, /<g transform=.*fill="none" stroke="#fff"/);
  assert.doesNotMatch(watermarkSource, /<text\b/);
  assert.match(client, /function watermarkDailyLookImage\(dataUri\)/);
  assert.match(client, /const label = 'Vaultlix'/);
  assert.match(client, /context\.fillStyle = 'rgba\(37,20,29,\.58\)'/);
  assert.match(client, /canvas\.toDataURL\('image\/jpeg', \.94\)/);
  assert.match(client, /if \(watermarkVersion < DAILY_LOOK_WATERMARK_VERSION\)/);
  assert.match(client, /finalImage = await watermarkDailyLookImage\(result\.generatedImage\)/);
  assert.match(client, /image:finalImage/);
  assert.match(client, /Number\(savedLook\.watermarkVersion\) < DAILY_LOOK_WATERMARK_VERSION/);
  const source = await sharp({ create:{ width:256, height:256, channels:3, background:'#d8c6bd' } }).jpeg().toBuffer();
  const branded = await watermarkDailyLookOutput(source);
  const metadata = await sharp(branded).metadata();
  assert.equal(metadata.format, 'jpeg');
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);
  assert.notDeepEqual(branded, source);
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
