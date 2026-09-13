const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('home page explains the Vaultlix-number user model without repetitive privacy copy', () => {
  assert.match(client, /aria-label="Your Vaultlix number\. No SIM required\."/);
  assert.match(client, /Create my number/);
  assert.equal((client.match(/Dating someone new, selling online or meeting a client\? Share Vaultlix and keep your personal number to yourself\./g) || []).length, 2);
  assert.match(client, /<span>No SIM<\/span><span>No phone number<\/span><span>No email<\/span><span>No contact upload<\/span>/);
  assert.match(client, /01 · Identify/);
  assert.match(client, /02 · Share/);
  assert.match(client, /03 · Decide/);
  assert.match(client, /People need your exact number, and you decide who connects/);
});

test('create and sign-in homepage actions open the correct account path directly', () => {
  assert.match(client, /class="landing-hero-action"[^>]*onclick="openCreateAccount\(\)"[^>]*>Create my number/);
  assert.match(client, /landing-hero-action-secondary"[^>]*onclick="openLoginOrInbox\(\)"[^>]*>Sign in/);
  assert.match(client, /function openCreateAccount\(\)[\s\S]{0,220}openAccountPanel\(\);[\s\S]{0,80}showAccountTab\('create'\)/);
  assert.match(client, /id="account-create-form"/);
  assert.match(client, /function openLoginOrInbox\(\)[\s\S]{0,220}openAccountPanel\(\);[\s\S]{0,80}showAccountTab\('login'\)/);
});

test('shareable create-number link opens account creation directly', () => {
  assert.match(client, /const startupCreateNumber = startupParams\.get\('create'\) === '1'/);
  assert.match(client, /else if \(startupCreateNumber && !loadAccountState\(\)\) \{\s*openCreateAccount\(\);/);
});

test('home page leads with relatable private-number use cases', () => {
  assert.match(client, /id="everyday-privacy"/);
  assert.match(client, /Keep your personal number for the people who already have it\./);
  assert.match(client, /Dating someone new/);
  assert.match(client, /Buying or selling/);
  assert.match(client, /Meeting a client/);
  assert.match(client, /No app installation required to open your invitation\. You decide whether to accept the connection\. When you’re finished, you can erase the conversation for both people\./);
  assert.doesNotMatch(client, /Selling on Marketplace/);
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

test('homepage motion system is layered, responsive and accessible', () => {
  assert.match(client, /id="vaultlix-motion-story"/);
  assert.match(client, /id="vaultlix-motion-story-scroll"/);
  assert.match(client, /id="vaultlix-motion-deck"/);
  assert.equal((client.match(/class="motion-deck-card"/g) || []).length, 3);
  assert.match(client, /\.motion-story-scroll\{position:relative;margin-top:30px\}/);
  assert.match(client, /\.motion-deck-card\{position:sticky;top:18px/);
  assert.match(client, /class="motion-story" id="vaultlix-motion-story"/);
  assert.match(client, /classList\.add\('motion-enhanced'\)/);
  assert.match(client, /const sectionObserver = new IntersectionObserver/);
  assert.doesNotMatch(client, /renderDeck = progress/);
  assert.doesNotMatch(client, /deckTrack\.offsetHeight - deckStory\.offsetHeight/);
  assert.doesNotMatch(client, /scheduleDeckUpdate/);
  assert.match(client, /@media\(prefers-reduced-motion:reduce\)[\s\S]*?\.motion-deck-card\{opacity:1!important;animation:none!important/);
  assert.match(client, /Your line, waiting for you/);
  assert.match(client, /@keyframes landing-word-build/);
  assert.match(client, /landing-reveal-accent::after/);
  assert.match(client, /id="vaultlix-motion-showcase"/);
  assert.match(client, /showcaseObserver\.observe\(panel\)/);
  assert.match(client, /\.motion-panel\.is-playing \.message-demo-bubble/);
  assert.match(client, /privacy-hook-copy motion-reveal/);
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
  assert.match(client, /const hue = unsignedHash % 360/);
  assert.match(client, /--avatar-bg:hsl\(/);
  assert.doesNotMatch(client, /VAULTLIX_AVATAR_PALETTES/);
  assert.match(client, /room\.peerPrivateNumber \|\| room\.code/);
  assert.match(client, /style="\$\{avatarStyle\}"/);
  assert.match(client, /\.call-peer-name\{[^}]*-webkit-line-clamp:2/);
  assert.match(client, /\.call-peer-name-compact\{[^}]*text-overflow:ellipsis/);
  assert.match(client, /maxlength="32"/);
});

test('every restored inbox conversation retains a visible activity date', () => {
  assert.match(client, /inboxActivityAt: new Date\(inboxActivityAt \|\| lastMessageAt \|\| connectedSince \|\| Date\.now\(\)\)/);
  assert.match(client, /inboxActivityAt:session\.inboxActivityAt \|\| session\.savedAt/);
  assert.match(client, /const fallbackTime = new Date\(room\.inboxActivityAt \|\| 0\)/);
  assert.match(client, /Math\.max\(messageTime, serverTime, connectedTime, fallbackTime, 0\)/);
});

test('one-to-one conversation polish uses safe areas and native visual language', () => {
  assert.match(client, /\.emergency-overlay\{[^}]*safe-area-inset-top/);
  assert.match(client, /vaultlix-native-android \.emergency-overlay/);
  assert.match(client, /#s-chat \.msg-name\{display:none!important\}/);
  assert.match(client, /class="e2e-bar"[\s\S]{0,500}<svg/);
  assert.doesNotMatch(client, /bar\.innerHTML = '[^']*🔒/);
  assert.match(client, /#s-chat #timer-bar-select\{[^}]*appearance:none!important/);
  assert.match(client, /\.status-dot\.away\{background:#AAA2A6/);
  assert.doesNotMatch(client, /Connection restored|sys-reconnect-/);
  assert.match(client, /if \(!isVisibleConversationRecord\(rec\)\) return null/);
  assert.match(client, /id="chat-peer-avatar"[^>]*onclick="openPeerProfileImage\(\)"/);
  assert.match(client, /function quickLockFromHeader\(\)/);
  assert.match(client, /onclick="quickLockFromConversationMenu\(\)"/);
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
