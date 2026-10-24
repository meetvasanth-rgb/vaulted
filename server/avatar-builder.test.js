'use strict';

// Step 2 of the avatar: a builder that draws the avatar on the device from CC0 Open Peeps parts, with
// optional suggestions from a photo. These tests run the real drawing code against the real parts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const partsSource = read('client/vendor/open-peeps.js');
const builderSource = read('client/avatar.js');
const suggestion = require('./avatar-suggestion');

function load() {
  const sandbox = vm.createContext({ window:{}, module:{ exports:{} }, document:{}, Math, JSON, Object, Number, String, Array, Image: function () {} });
  vm.runInContext(partsSource, sandbox);
  vm.runInContext(builderSource, sandbox);
  return { builder:sandbox.module.exports, parts:sandbox.window.VaultlixPeeps };
}

test('the art is the CC0 Open Peeps set, credited, with its licence text shipped beside it', () => {
  assert.match(partsSource, /^\/\*[\s\S]*Open Peeps by Pablo Stanley[\s\S]*CC0 1\.0/);
  assert.match(partsSource, /DiceBear @dicebear\/open-peeps 9\.4\.2 \(MIT/);
  const license = read('client/vendor/open-peeps.LICENSE.txt');
  assert.match(license, /CC0 1\.0/);
  assert.match(license, /MIT License/);
  assert.match(license, /Pablo Stanley/);
});

test('the parts file has every group the builder and the server suggestion rely on', () => {
  const { parts } = load();
  assert.equal(parts.viewBox, '0 0 704 704');
  assert.equal(Object.keys(parts.head).length, 48);
  assert.equal(Object.keys(parts.face).length, 30);
  assert.equal(Object.keys(parts.facialHair).length, 16);
  assert.equal(Object.keys(parts.accessories).length, 8);
  assert.deepEqual([parts.colors.skin.length, parts.colors.hair.length, parts.colors.clothing.length], [5, 10, 7]);
  assert.ok(parts.hairColoured.length > 0 && parts.hairColoured.every(name => name in parts.head));
});

test('the server suggestion lists are exactly the builder\'s parts (so a suggestion is always drawable)', () => {
  const { parts } = load();
  const sorted = value => [...value].sort();
  assert.deepEqual(sorted(suggestion.HEADS), sorted(Object.keys(parts.head)));
  assert.deepEqual(sorted(suggestion.FACIAL_HAIR), sorted(Object.keys(parts.facialHair)));
  assert.deepEqual(sorted(suggestion.ACCESSORIES), sorted(Object.keys(parts.accessories)));
  assert.ok(suggestion.FACES.every(name => name in parts.face));
  assert.deepEqual([suggestion.COUNTS.skin, suggestion.COUNTS.hair, suggestion.COUNTS.clothing], [parts.colors.skin.length, parts.colors.hair.length, parts.colors.clothing.length]);
});

test('every hairstyle, expression, beard and pair of glasses draws as complete SVG with no placeholder left', () => {
  const { builder, parts } = load();
  const base = builder.defaultSelection();
  const cases = [
    ...Object.keys(parts.head).map(head => ({ ...base, head })),
    ...Object.keys(parts.face).map(face => ({ ...base, face })),
    ...Object.keys(parts.facialHair).map(facialHair => ({ ...base, facialHair })),
    ...Object.keys(parts.accessories).map(accessories => ({ ...base, accessories })),
  ];
  assert.equal(cases.length, 102);
  for (const selection of cases) {
    for (const thumb of [false, true]) {
      const svg = builder.avatarSvg(selection, { size:64, thumb }, parts);
      assert.ok(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"') && svg.endsWith('</svg>'));
      assert.doesNotMatch(svg, /@[SCH]@/, JSON.stringify(selection));
      assert.equal((svg.match(/<g[ >]/g) || []).length, (svg.match(/<\/g>/g) || []).length, 'balanced groups');
      assert.equal((svg.match(/<svg/g) || []).length, 1);
    }
  }
});

test('the full avatar has shoulders and a background; a thumbnail is just the head', () => {
  const { builder, parts } = load();
  const full = builder.avatarSvg(builder.defaultSelection(), { size:256 }, parts);
  const thumb = builder.avatarSvg(builder.defaultSelection(), { size:80, thumb:true }, parts);
  assert.match(full, /viewBox="0 0 704 704" width="256" height="256"/);
  assert.match(full, /<rect width="704" height="704" fill="#F3E6EA"\/>/);
  assert.ok(full.includes(parts.torso.slice(0, 120).replace(/@S@|@C@/g, '')) || full.includes('<path'), 'torso drawn');
  assert.doesNotMatch(thumb, /<rect/);
  assert.ok(thumb.length < full.length);
  assert.match(thumb, /viewBox="80 -20 540 540"/);
});

test('choices change the colours: skin, top, hair (on styles that take a colour) and background', () => {
  const { builder, parts } = load();
  const svg = selection => builder.avatarSvg(selection, { size:64 }, parts);
  const base = builder.defaultSelection();
  assert.ok(svg({ ...base, skin:0 }).includes(`#${parts.colors.skin[0]}`));
  assert.ok(svg({ ...base, skin:4 }).includes(`#${parts.colors.skin[4]}`));
  assert.ok(svg({ ...base, clothing:6 }).includes(`#${parts.colors.clothing[6]}`));
  assert.ok(svg({ ...base, background:3 }).includes(builder.BACKGROUNDS[3]));
  const coloured = parts.hairColoured[0];
  assert.ok(svg({ ...base, head:coloured, hair:3 }).includes(`#${parts.colors.hair[3]}`));
  assert.ok(!svg({ ...base, head:coloured, hair:3 }).includes('@H@'));
});

test('a stored or suggested selection can never draw something that does not exist', () => {
  const { builder, parts } = load();
  const messy = { head:'<script>', face:5, facialHair:'nope', accessories:'glasses', skin:99, hair:-1, clothing:'x', background:1.5 };
  const clean = builder.normalizeSelection(messy, parts);
  const base = builder.defaultSelection();
  assert.deepEqual(JSON.parse(JSON.stringify(clean)), { ...base, accessories:'glasses', facialHair:base.facialHair });
  assert.deepEqual(JSON.parse(JSON.stringify(builder.normalizeSelection(null, parts))), JSON.parse(JSON.stringify(base)));
  // None is a valid choice for beard and glasses.
  assert.equal(builder.normalizeSelection({ facialHair:null, accessories:null }, parts).facialHair, null);
  assert.doesNotMatch(builder.avatarSvg(messy, {}, parts), /<script/);
});

test('"Surprise me" is always valid and varies', () => {
  const { builder, parts } = load();
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const selection = builder.randomSelection(random, parts);
    assert.deepEqual(JSON.parse(JSON.stringify(builder.normalizeSelection(selection, parts))), JSON.parse(JSON.stringify(selection)));
    seen.add(JSON.stringify(selection));
  }
  assert.ok(seen.size > 40);
});

test('a photo suggestion replaces only the features it names', () => {
  const { builder, parts } = load();
  const start = { ...builder.defaultSelection(), head:'bangs', skin:1, clothing:2 };
  const merged = builder.applySuggestion(start, { skin:3, facialHair:'moustache2', face:'smileBig', hair:7 }, parts);
  assert.equal(merged.skin, 3);
  assert.equal(merged.facialHair, 'moustache2');
  assert.equal(merged.face, 'smileBig');
  assert.equal(merged.head, 'bangs', 'untouched');
  assert.equal(merged.clothing, 2, 'untouched');
  assert.equal(builder.applySuggestion(start, { facialHair:null }, parts).facialHair, null, 'a clean-shaven suggestion clears the beard');
  assert.deepEqual(JSON.parse(JSON.stringify(builder.applySuggestion(start, 'garbage', parts))), JSON.parse(JSON.stringify(start)));
});

test('server: model output is reduced to valid choices only', () => {
  const clean = suggestion.normalizeSuggestion({ skin:2, hair:7, head:'short2', face:'smile', facialHair:'moustache1', accessories:'none', clothing:5 });
  assert.deepEqual(clean, { skin:2, hair:7, head:'short2', face:'smile', facialHair:'moustache1', accessories:null, clothing:5 });
  const hostile = suggestion.normalizeSuggestion({ skin:9, hair:'3', head:'../../x', face:'rage', facialHair:'none', accessories:'<img>', clothing:-1, extra:'ignored' });
  assert.deepEqual(hostile, { facialHair:null });
  assert.deepEqual(suggestion.normalizeSuggestion(null), {});
  assert.deepEqual(suggestion.normalizeSuggestion('x'), {});
  assert.equal(suggestion.parseSuggestionResponse({ choices:[{ message:{ content:'not json' } }] }), null);
  assert.equal(suggestion.parseSuggestionResponse({}), null);
  assert.deepEqual(suggestion.parseSuggestionResponse({ choices:[{ message:{ content:JSON.stringify({ skin:1, head:'bangs' }) } }] }), { skin:1, head:'bangs' });
});

test('server: the request asks for strict JSON from the builder\'s own lists, with a low-detail image', () => {
  const body = suggestion.suggestionRequest('model-x', 'data:image/jpeg;base64,AAAA');
  assert.equal(body.model, 'model-x');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  assert.deepEqual(schema.properties.head.enum, suggestion.HEADS);
  assert.ok(schema.properties.facialHair.enum.includes('none') && schema.properties.accessories.enum.includes('none'));
  const content = body.messages[0].content;
  assert.equal(content[1].image_url.detail, 'low');
  assert.match(content[0].text, /Do not guess age, identity/);
  assert.doesNotMatch(content[0].text, /who is this|identify the person/i);
});

test('server: the route is rate limited, moderated, key-gated, and never stores the photo', () => {
  const server = read('server/index.js');
  const route = server.slice(server.indexOf("path === '/api/account/avatar-suggest'"), server.indexOf("path === '/api/account/daily-look' && method"));
  assert.match(route, /authenticateAccountSession\(d\.accountId, d\.sessionToken\)/);
  assert.match(route, /rateLimited\(`avatar-suggest:\$\{d\.accountId\}`, 12, 24 \* 60 \* 60 \* 1000\)/);
  assert.match(route, /if \(!apiKey\) return resErr\(res, 'Avatar suggestions are temporarily unavailable\.', 503\)/);
  assert.match(route, /parseDailyLookImage\(d\.image\)/);
  assert.match(route, /moderateDailyLookImage\(d\.image, apiKey\)/);
  assert.match(route, /process\.env\.OPENAI_AVATAR_MODEL \|\| 'gpt-4\.1-mini'/);
  assert.match(route, /Cache-Control', 'no-store'/);
  assert.doesNotMatch(route, /persistAccount|writeFile|dailyLookGenerationCount/, 'nothing is saved and it does not use a Daily Look creation');
  assert.match(server, /pathname === '\/api\/account\/daily-look' \|\| pathname === '\/api\/account\/avatar-suggest'\) return BODY_LIMIT_DAILY_LOOK/);
});

test('the page loads the builder on demand and the sheet is wired to the right server route', () => {
  const client = read('client/index.html');
  assert.match(client, /add\('\/vendor\/open-peeps\.js'\)\.then\(\(\) => add\('\/avatar\.js'\)\)/);
  assert.match(client, /async function openAvatarBuilder\(\)/);
  assert.match(builderSource, /api\('\/api\/account\/avatar-suggest'/);
  assert.match(builderSource, /saveProfileImageUpdate\('replace', jpeg\)/);
  // The sheet calls the page's api(); the module's own export object must not shadow it.
  assert.doesNotMatch(builderSource, /\bconst api\b/);
  assert.match(builderSource, /I agree to send the photo I pick to OpenAI to suggest features for my avatar/);
  assert.match(builderSource, /Vaultlix does not keep it/);
});
