'use strict';

// Like Snapchat, "typing" shows the other person's picture with a small bubble of dots on it, instead of
// a bare grey pill of dots. Without a profile picture their initial stands in.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

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

function harness() {
  const avatar = { innerHTML:'', dataset:{} };
  let mic = null;
  const indicator = {
    shown:false, recording:false, label:'',
    classList:{ toggle: (name, on) => { if (name === 'show') indicator.shown = on; if (name === 'recording') indicator.recording = on; } },
    querySelector: selector => selector === '#typing-avatar' ? avatar : (selector === '.peer-typing-mic' ? mic : null),
    appendChild: child => { mic = child; },
    setAttribute: (name, value) => { if (name === 'aria-label') indicator.label = value; },
  };
  const context = vm.createContext({
    document: { getElementById: id => id === 'typing-indicator' ? indicator : null, createElement: () => ({ className:'', innerHTML:'' }) },
    displayProfileImageUri: value => typeof value === 'string' && value.startsWith('data:image/') ? value : null,
    escapeHtml: value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`),
    roomDisplayLabel: room => room?.peerName || '',
    getActiveRoom: () => ({ peerName:'Active' }),
    Array,
  });
  vm.runInContext(extractFunction('typingAvatarHtml') + '\n' + extractFunction('showTypingIndicator'), context);
  return { context, avatar, indicator, getMic: () => mic };
}

test('their profile picture is shown beside the dots', () => {
  const h = harness();
  h.context.showTypingIndicator(true, { peerName:'Velvet', peerProfileImage:'data:image/jpeg;base64,AAAA' });
  assert.equal(h.indicator.shown, true);
  assert.match(h.avatar.innerHTML, /^<img src="data:image\/jpeg;base64,AAAA" alt=""\/>$/);
});

test('without a picture their initial stands in, escaped', () => {
  const h = harness();
  h.context.showTypingIndicator(true, { peerName:'doodles' });
  assert.equal(h.avatar.innerHTML, 'D');
  h.context.showTypingIndicator(true, { peerName:'<b>x' });
  assert.equal(h.avatar.innerHTML, '&#60;');
  h.context.showTypingIndicator(true, { peerName:'' });
  assert.equal(h.avatar.innerHTML, '·');
});

test('an unsafe picture value is never used as an image source', () => {
  const h = harness();
  h.context.showTypingIndicator(true, { peerName:'Eve', peerProfileImage:'javascript:alert(1)' });
  assert.equal(h.avatar.innerHTML, 'E');
});

test('hiding leaves the picture alone, and the active conversation is the default', () => {
  const h = harness();
  h.context.showTypingIndicator(true, { peerName:'Velvet' });
  h.context.showTypingIndicator(false, { peerName:'Other' });
  assert.equal(h.indicator.shown, false);
  assert.equal(h.avatar.innerHTML, 'V');
  h.context.showTypingIndicator(true);
  assert.equal(h.avatar.innerHTML, 'A');
});

test('every real typing indicator carries the avatar and the dots, and every caller passes its conversation', () => {
  // The static chat body plus the three places that rebuild it.
  const indicators = client.match(/<div class="typing-indicator peer-typing" id="typing-indicator" aria-label="Typing">\s*<span class="peer-typing-avatar" id="typing-avatar"><\/span><span class="peer-typing-dots"><i class="t-dot"><\/i><i class="t-dot"><\/i><i class="t-dot"><\/i><\/span>/g) || [];
  assert.equal(indicators.length, 4);
  assert.equal((client.match(/showTypingIndicator\((?:!!update\.typing|message\.active !== false|data\.typing), room, (?:update|message|data)\.activity\)/g) || []).length, 3);
  // The loading placeholder keeps the plain pill.
  assert.match(client, /chat-restore-pending" role="status"><div class="typing-indicator show" id="typing-indicator"><div class="t-dot">/);
  assert.match(client, /#s-chat \.typing-indicator\.peer-typing\{background:transparent!important;border:0!important\}/);
});
