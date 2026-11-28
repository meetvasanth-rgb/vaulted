'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('server/index.js', 'utf8');

function presetHarness() {
  const ctx = vm.createContext({});
  const catalogStart = source.indexOf('const DAILY_LOOK_STYLES = Object.freeze(');
  const catalogEnd = source.indexOf('\n]);', catalogStart) + 4;
  const identityStart = source.indexOf('const SOURCE_PHOTO_ENHANCEMENT_PROMPT =');
  const identityEnd = source.indexOf('const DAILY_LOOK_BLEMISH_PROMPTS', identityStart);
  const promptStart = source.indexOf('function dailyLookDirectedPrompt(');
  const promptEnd = source.indexOf('function dailyLookCanvas(', promptStart);
  const createStart = source.indexOf('async function createDailyLook(');
  const createEnd = source.indexOf('async function claimDailyLook(', createStart);
  vm.runInContext(source.slice(catalogStart, catalogEnd) + source.slice(identityStart, identityEnd) + source.slice(promptStart, promptEnd) + source.slice(createStart, createEnd) + `
    style = DAILY_LOOK_STYLES.find(style => style.id === 'golden-hour');
    dailyLookCanvas = () => ({sourceWidth:640, sourceHeight:480});
    createGeminiDailyLook = () => {throw Error('unexpected Gemini route')};
    createOpenAiDailyLook = async (image, style, key, prompt, canvas) => ({image, style, key, prompt, canvas});
  `, ctx);
  return ctx;
}

test('Golden Hour sends the original source to OpenAI with a dedicated face-preservation contract', async () => {
  const ctx = presetHarness();
  assert.equal(ctx.style.provider, 'openai');
  assert.equal(ctx.style.processor, undefined);
  assert.equal(ctx.style.quality, 'high');
  const image = {bytes:Buffer.from('source-image')};
  const result = await ctx.createDailyLook(image, ctx.style, 'test-key');
  assert.equal(result.image, image);
  assert.equal(result.key, 'test-key');
  assert.match(result.prompt, /Preserve natural pores and skin texture/);
  assert.match(result.prompt, /Facial identity and texture have absolute priority/);
  assert.match(result.prompt, /clearly visible.*directional sunlight/);
  assert.match(result.prompt, /do not redraw, retouch, smooth or refine the face/i);
  assert.match(result.prompt, /LIGHTING-ONLY EDIT/);
  assert.match(result.prompt, /NO skin smoothing, denoising, noise reduction, sharpening/);
  assert.match(result.prompt, /reduce or omit that effect instead/);
  assert.doesNotMatch(result.prompt, /Mandatory Lifestyle collection finishing|complete professional portrait-lighting pass|restrained capture noise/);
});

test('OpenAI failure is surfaced rather than silently returning a local filter', async () => {
  const ctx = presetHarness();
  ctx.createOpenAiDailyLook = async () => {throw Error('provider-failed')};
  await assert.rejects(ctx.createDailyLook({}, ctx.style, 'test-key'), /provider-failed/);
  assert.doesNotMatch(source, /createLocalGoldenHour|gradeGoldenHour|processor === 'local'/);
});

test('Golden Hour provider failures release the claim without spending a daily creation', async () => {
  const source = fs.readFileSync('server/index.js', 'utf8');
  const route = source.slice(source.indexOf("  if (path === '/api/account/daily-look' && method === 'POST')"), source.indexOf("  if (path === '/api/account/sync' && method === 'POST')"));
  const account = { dailyLookGenerationCount:4 };
  let released = 0, persisted = 0;
  const ctx = vm.createContext({ Date, Math, String, Number, console:{warn(){}},
    validAccountId:()=>true, authenticateAccountSession:()=>account,
    dailyLookDayWindow:()=>({startedAt:1}), rateLimited:async()=>false,
    DAILY_LOOK_STYLES:[{id:'golden-hour',provider:'openai'}], parseDailyLookImage:()=>({}),
    dailyLookUsage:()=>({count:4,remaining:11}), DAILY_LOOK_DAILY_LIMIT:15,
    claimDailyLook:async()=>true, releaseDailyLookClaim:async()=>{released++},
    dailyLookSourceDimensions:async()=>({width:32,height:32}), dailyLookVariantIndex:()=>0,
    OPENAI_API_KEY:'test-key', moderateDailyLookImage:async()=>false,
    createDailyLook:async()=>{throw Error('image-502-provider')},
    persistAccount:async()=>{persisted++},
    resErr:(_,error,status)=>({error,status}), res200:()=>{throw Error('unexpected success')}
  });
  vm.runInContext(`async function run(){ const path='/api/account/daily-look',method='POST',ip='test'; const d={accountId:'test',styleId:'golden-hour',portraitConsentVersion:1}; const res={setHeader(){}}; ${route} }`, ctx);
  const result = await ctx.run();
  assert.equal(result.status, 502);
  assert.match(result.error, /Your daily creation is still available/);
  assert.equal(released, 1);
  assert.equal(persisted, 0);
  assert.equal(account.dailyLookGenerationCount, 4);
});
