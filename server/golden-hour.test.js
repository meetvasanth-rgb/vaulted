'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const sharp = require('sharp');
const { gradeGoldenHour } = require('./golden-hour');

test('Golden Hour visibly lifts a real portrait while keeping dimensions and stripping metadata', async () => {
  const bytes = fs.readFileSync('client/portrait-samples/selfie-soft-daylight-before.v2.webp');
  const output = await gradeGoldenHour(bytes, 384, 512);
  const meta = await sharp(output).metadata();
  assert.equal(meta.width, 384);
  assert.equal(meta.height, 512);
  assert.equal(meta.exif, undefined);
  const original = await sharp(bytes).resize(384, 512, { fit:'cover' }).removeAlpha().raw().toBuffer();
  const result = await sharp(output).raw().toBuffer();
  let delta = 0, beforeY = 0, afterY = 0;
  for (let i = 0; i < result.length; i++) delta += Math.abs(result[i] - original[i]);
  for (let i = 0; i < result.length; i += 3) {
    beforeY += original[i] * .2126 + original[i+1] * .7152 + original[i+2] * .0722;
    afterY += result[i] * .2126 + result[i+1] * .7152 + result[i+2] * .0722;
  }
  assert.ok(delta / result.length > 8, 'visible grade rather than JPEG noise');
  assert.ok(afterY > beforeY, 'face/scene midtones are lifted rather than darkened');
});

test('identical colours keep identical treatment without moving edges or smoothing texture', async () => {
  const data = Buffer.alloc(64 * 64 * 3);
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    const i = (y * 64 + x) * 3;
    const v = x < 32 ? 70 : 150;
    data[i] = v + (y % 2) * 12; data[i+1] = v; data[i+2] = v - 15;
  }
  const bytes = await sharp(data, { raw:{ width:64, height:64, channels:3 } }).png().toBuffer();
  const output = await sharp(await gradeGoldenHour(bytes, 64, 64)).raw().toBuffer();
  for (let y = 0; y < 64; y++) {
    assert.ok(output[(y * 64 + 32) * 3] - output[(y * 64 + 31) * 3] > 60, 'edge remains at original column');
  }
  assert.ok(output[(17 * 64 + 10) * 3] - output[(16 * 64 + 10) * 3] >= 8, 'fine texture survives');
});

test('clipped black and white inputs cannot spend an attempt on unchanged output', async () => {
  for (const background of ['#000000', '#ffffff']) {
    const bytes = await sharp({ create:{ width:32, height:32, channels:3, background } }).png().toBuffer();
    await assert.rejects(gradeGoldenHour(bytes, 32, 32), /golden-hour-no-visible-change/);
  }
});

test('the real route releases its claim and leaves the daily count untouched when the grade has no visible effect', async () => {
  const source = fs.readFileSync('server/index.js', 'utf8');
  const route = source.slice(source.indexOf("  if (path === '/api/account/daily-look' && method === 'POST')"), source.indexOf("  if (path === '/api/account/sync' && method === 'POST')"));
  const account = { dailyLookGenerationCount:4 };
  let released = 0, persisted = 0;
  const ctx = vm.createContext({ Date, Math, String, Number, console:{warn(){}},
    validAccountId:()=>true, authenticateAccountSession:()=>account,
    dailyLookDayWindow:()=>({startedAt:1}), rateLimited:async()=>false,
    DAILY_LOOK_STYLES:[{id:'golden-hour',processor:'local'}], parseDailyLookImage:()=>({}),
    dailyLookUsage:()=>({count:4,remaining:11}), DAILY_LOOK_DAILY_LIMIT:15,
    claimDailyLook:async()=>true, releaseDailyLookClaim:async()=>{released++},
    dailyLookSourceDimensions:async()=>({width:32,height:32}), dailyLookVariantIndex:()=>0,
    createDailyLook:async()=>{throw Error('golden-hour-no-visible-change')},
    persistAccount:async()=>{persisted++},
    resErr:(_,error,status)=>({error,status}), res200:()=>{throw Error('unexpected success')}
  });
  vm.runInContext(`async function run(){ const path='/api/account/daily-look',method='POST',ip='test'; const d={accountId:'test',styleId:'golden-hour',portraitConsentVersion:1}; const res={setHeader(){}}; ${route} }`, ctx);
  const result = await ctx.run();
  assert.equal(result.status, 422);
  assert.match(result.error, /No portrait attempt was used/);
  assert.equal(released, 1);
  assert.equal(persisted, 0);
  assert.equal(account.dailyLookGenerationCount, 4);
});
