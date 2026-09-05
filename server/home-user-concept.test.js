const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('home page explains the private-number user model', () => {
  assert.match(client, /aria-label="Your private number\. No SIM required\."/);
  assert.match(client, /Get my Vaultlix number/);
  assert.equal((client.match(/Get your own Vaultlix Private Number and connect privately—without sharing your phone number\./g) || []).length, 2);
  assert.match(client, /<span>No SIM<\/span><span>No phone number<\/span><span>No email<\/span><span>No contact upload<\/span>/);
  assert.match(client, /01 · Identify/);
  assert.match(client, /02 · Approve/);
  assert.match(client, /03 · Connect/);
  assert.match(client, /People must know the exact number and you decide whether to connect/);
});

test('home page footer does not repeat the FAQ section', () => {
  const footer = client.match(/<div class="landing-footer">([\s\S]*?)<\/div>/)?.[1] || '';
  assert.equal((footer.match(/showScreen\('s-faq'\)/g) || []).length, 0);
});

test('home page explains privacy without infrastructure jargon', () => {
  const marketing = client.match(/<div class="landing-marketing"[\s\S]*?<\/main>/)?.[0] || '';
  assert.match(marketing, /Strong 256-bit encryption protects every message/);
  assert.match(marketing, /Vaultlix cannot listen to or record them/);
  for (const jargon of ['WebRTC', 'DTLS-SRTP', 'TURN service', 'ciphertext', 'Operational metadata', 'client-encrypted account bundle']) {
    assert.equal(marketing.includes(jargon), false, `homepage jargon remains: ${jargon}`);
  }
});

test('homepage motion demos are isolated from real conversations', () => {
  const marketing = client.match(/<div class="landing-marketing"[\s\S]*?<\/main>/)?.[0] || '';
  const chat = client.match(/<div id="s-chat"[\s\S]*?<div id="s-vault-list"/)?.[0] || '';
  assert.match(marketing, /id="private-conversation-demo"/);
  assert.match(marketing, /class="message-demo"/);
  assert.match(marketing, /class="privacy-scroll-stage"/);
  assert.match(client, /IntersectionObserver/);
  assert.equal(chat.includes('message-demo'), false);
  assert.equal(chat.includes('privacy-scroll-stage'), false);
});

test('settings headings share the submenu font family', () => {
  assert.match(client, /\.settings-header-title\{font-family:'Inter',sans-serif/);
  assert.match(client, /\.settings-about-name\{font-family:'Inter',sans-serif/);
  assert.doesNotMatch(client, /\.settings-header-title\{font-family:'(?:Bodoni Moda|Cormorant Garamond)'/);
  assert.match(client, /\.emergency-title\{font:700 26px\/1\.15 'Inter',sans-serif/);
  assert.match(client, /\.safety-title\{font:700 26px\/1\.15 'Inter',sans-serif/);
  assert.match(client, /\.call-peer-name\{[^}]*font-family:'Inter',sans-serif/);
});

test('emergency choices use accessible Vaultlix radio controls', () => {
  assert.match(client, /\.emergency-choice input\[type="radio"\]\{[^}]*width:44px;height:44px/);
  assert.match(client, /\.emergency-choice input\[type="radio"\]:checked\{[^}]*#682C43/);
  assert.match(client, /input\[type="radio"\]\[value="account"\]:checked/);
  assert.match(client, /input\[type="radio"\]:focus-visible/);
  assert.match(client, /\.emergency-choice:has\(input\[type="radio"\]:checked\)/);
});

test('contact identity is visually stable and long names remain bounded', () => {
  assert.match(client, /function vaultAvatarPalette\(seed\)/);
  assert.match(client, /room\.peerPrivateNumber \|\| room\.code/);
  assert.match(client, /style="\$\{avatarStyle\}"/);
  assert.match(client, /\.call-peer-name\{[^}]*-webkit-line-clamp:2/);
  assert.match(client, /\.call-peer-name-compact\{[^}]*text-overflow:ellipsis/);
  assert.match(client, /maxlength="32"/);
});

test('user-facing legacy vault labels are replaced with conversation language', () => {
  for (const legacy of [
    'Create a vault',
    'Vault ready',
    'Label this vault',
    'Tap to open vault',
    'Private vault',
    'Vault erased',
    'Start a new vault',
    'Make this a permanent vault?',
  ]) assert.equal(client.includes(legacy), false, `legacy label remains: ${legacy}`);
});
