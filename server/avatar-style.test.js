'use strict';

// Step 1 of the avatar: a "My Avatar" style on the existing Daily Look pipeline (OpenAI image edit, the
// same consent, moderation, limits and no-keep rule), always a square head-and-shoulders cartoon, and a
// one-time offer card in the inbox for accounts that have no profile picture yet.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');

function extractFunction(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('the avatar style is square, medium quality, identity-preserving and brand-free', () => {
  const style = server.slice(server.indexOf("id:'vaultlix-avatar'"), server.indexOf("id:'surprise-enhancer'"));
  assert.match(style, /canvas:'square', size:'1024x1024', quality:'medium'/);
  assert.match(style, /unmistakably the same person/);
  assert.match(style, /face shape and proportions, skin tone, hair colour, hair style and hairline/);
  assert.match(style, /Keep their apparent age, gender presentation and build exactly as they are/);
  assert.match(style, /single most prominent or central person only/);
  assert.match(style, /Do not depict a celebrity, a character or any real person other than the one photographed/);
  assert.match(style, /Do not generate any text, logo or watermark/);
  assert.doesNotMatch(style, /Bitmoji|Snapchat|Pixar|Disney/i, 'no third-party brand in the prompt');
});

test('a square style replaces the "never make it a square" instruction and always renders 1024x1024', () => {
  const create = server.slice(server.indexOf('async function createDailyLook('), server.indexOf('async function claimDailyLook('));
  assert.match(create, /const squareOutput = style\.canvas === 'square'/);
  assert.match(create, /squareOutput \? 1024 : \(dimensions\?\.width \|\| 1024\)/);
  assert.match(create, /Create the avatar on a square 1:1 canvas/);
  // The ordinary instruction is unchanged for every other style.
  assert.match(create, /Do not convert the composition into a square or crop it to a profile portrait/);
  const route = server.slice(server.indexOf("path === '/api/account/daily-look' && method"));
  assert.match(route.slice(0, 5000), /width:style\.canvas === 'square' \? 1024 : dimensions\.width, height:style\.canvas === 'square' \? 1024 : dimensions\.height/);
  // Same consent, moderation, per-account limit and no-keep rule as every Daily Look.
  assert.match(route.slice(0, 3000), /moderateDailyLookImage\(d\.image, apiKey\)/);
  assert.match(route.slice(0, 3000), /claimDailyLook\(d\.accountId, account, now\)/);
});

test('the avatar style is listed first and is publicly selectable by id', () => {
  const block = server.match(/const DAILY_LOOK_STYLES = Object\.freeze\(\[([\s\S]*?)\n\]\);/)[1];
  const ids = [...block.matchAll(/\n  \{\n(?:\s*\/\/[^\n]*\n)*\s*id:'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(ids, ['vaultlix-avatar', 'surprise-enhancer']);
});

function offerHarness({ state, stored = {} }) {
  const store = new Map(Object.entries(stored));
  const context = vm.createContext({
    loadAccountState: () => state,
    localStorage: { getItem: key => store.has(key) ? store.get(key) : null, setItem: (key, value) => store.set(key, value) },
    renderVaultList: () => { context.rendered = (context.rendered || 0) + 1; },
    openDailyLook: options => { context.opened = options; },
    AVATAR_STYLE_ID: 'vaultlix-avatar',
    Map,
  });
  vm.runInContext("const AVATAR_OFFER_KEY_PREFIX = 'vaultlix_avatar_offer:';\n" + ['avatarOfferKey', 'avatarOfferDismissed', 'dismissAvatarOffer', 'openAvatarFromPhoto', 'avatarOfferHtml'].map(extractFunction).join('\n'), context);
  return { context, store };
}

test('an account without a profile picture is offered an avatar, once', () => {
  const h = offerHarness({ state:{ accountId:'acc1', profileImage:null } });
  const html = h.context.avatarOfferHtml();
  assert.match(html, /Make your avatar/);
  assert.match(html, /onclick="openAvatarBuilder\(\)">Create</);
  assert.match(html, /onclick="dismissAvatarOffer\(\)">Not now</);
  h.context.dismissAvatarOffer();
  assert.equal(h.store.get('vaultlix_avatar_offer:acc1'), 'dismissed', 'its own key, not a conversation record');
  assert.equal(h.context.avatarOfferHtml(), '');
  assert.equal(h.context.rendered, 1, 'the inbox is redrawn without the card');
});

test('no offer once there is a profile picture, when signed out, or after it was dismissed earlier', () => {
  assert.equal(offerHarness({ state:{ accountId:'acc1', profileImage:'data:image/jpeg;base64,AAAA' } }).context.avatarOfferHtml(), '');
  assert.equal(offerHarness({ state:null }).context.avatarOfferHtml(), '');
  assert.equal(offerHarness({ state:{ accountId:'acc1' }, stored:{ 'vaultlix_avatar_offer:acc1':'dismissed' } }).context.avatarOfferHtml(), '');
  // Another account on the same device is not affected.
  assert.match(offerHarness({ state:{ accountId:'acc2' }, stored:{ 'vaultlix_avatar_offer:acc1':'dismissed' } }).context.avatarOfferHtml(), /Make your avatar/);
});

test('The photo route opens the Daily Look sheet on the avatar style and the sheet is reworded', () => {
  const h = offerHarness({ state:{ accountId:'acc1' } });
  h.context.openAvatarFromPhoto();
  assert.deepEqual(JSON.parse(JSON.stringify(h.context.opened)), { styleId:'vaultlix-avatar' });
  const open = extractFunction('openDailyLook');
  assert.match(open, /const avatarMode = options\.styleId === AVATAR_STYLE_ID/);
  assert.match(open, /dailyLookStyleId = avatarMode \? AVATAR_STYLE_ID : null/);
  assert.doesNotMatch(open, /loadDailyLookResult\(/);
  const apply = extractFunction('applyDailyLookMode');
  assert.match(apply, /Your Vaultlix avatar/);
  assert.match(apply, /The photo is not kept/);
  // Only the avatar style is shown in avatar mode, and the profile button keeps its meaning.
  assert.match(extractFunction('renderDailyLookStyles'), /style\.id === AVATAR_STYLE_ID/);
  assert.match(client, /onclick="openAvatarBuilder\(\)">Create my avatar<\/button>/);
  assert.match(client, /onclick="openAvatarFromPhoto\(\)">Avatar from a photo<\/button>/);
  assert.match(client, /let html = searchQuery \? '' : inviteCardHtml\(\) \+ avatarOfferHtml\(\) \+ dailyLookNudgeHtml\(\) \+ requestsRowHtml\(\);/);
});
