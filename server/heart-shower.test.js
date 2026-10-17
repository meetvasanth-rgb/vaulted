'use strict';

// The heart reaction used to be a few hearts drifting up from the bottom of the screen. It is now a
// bucket's worth of hearts poured out at the top and falling with gravity, for both the call
// reaction and a chat message that is just a heart. Other emoji keep the upward float.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(name) {
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

function harness({ reduced = false } = {}) {
  const appended = [];
  const makeEl = () => {
    const el = { className:'', textContent:'', style:{ props:{}, setProperty(k, v) { this.props[k] = v; } }, listeners:{} };
    el.addEventListener = (type, fn) => { el.listeners[type] = fn; };
    el.remove = () => { el.removed = true; };
    return el;
  };
  const context = vm.createContext({
    window: { matchMedia: () => ({ matches:reduced }) },
    document: { createElement: makeEl, body: { appendChild: el => appended.push(el) } },
    Math,
  });
  vm.runInContext(extract('isHeartEmoji') + '\n' + extract('playHeartShower'), context);
  return { context, appended };
}

test('only the red heart (with or without the emoji selector) triggers the shower', () => {
  const { context } = harness();
  assert.equal(context.isHeartEmoji('❤️'), true);
  assert.equal(context.isHeartEmoji('❤'), true);
  for (const other of ['👍', '💕', '🎈', 'hi', '', null]) assert.equal(context.isHeartEmoji(other), false);
});

test('the shower covers the whole screen: hearts start along the entire top edge and clean themselves up', () => {
  const { context, appended } = harness();
  context.playHeartShower();
  assert.ok(appended.length >= 115 && appended.length <= 135, `${appended.length} hearts`);
  const xs = appended.map(el => parseFloat(el.style.props['--x']));
  assert.ok(xs.every(x => x >= 2 && x <= 96));
  // Spread across the width in every fifth of the screen, not clustered at the centre.
  for (let band = 0; band < 5; band++) {
    assert.ok(xs.some(x => x >= band * 20 && x < (band + 1) * 20), `no heart starts in band ${band + 1} of 5`);
  }
  for (const el of appended) {
    assert.equal(el.className, 'heart-shower');
    assert.ok(Math.abs(parseFloat(el.style.props['--drift'])) <= 9);
    assert.ok(parseFloat(el.style.props['--delay']) <= 900);
    assert.equal(typeof el.listeners.animationend, 'function');
    el.listeners.animationend();
    assert.equal(el.removed, true);
  }
});

test('reduced-motion users get a handful of hearts, not the full pour', () => {
  const { context, appended } = harness({ reduced:true });
  context.playHeartShower();
  assert.equal(appended.length, 12);
});

test('the heart now falls from the top: CSS starts above the screen and ends below it', () => {
  const css = client.slice(client.indexOf('.heart-shower{'), client.indexOf('/* Punch'));
  assert.match(css, /\.heart-shower\{position:fixed;top:0;left:var\(--x\)/);
  assert.match(css, /0%\{opacity:0;transform:translate\(0,-14vh\)/);
  assert.match(css, /100%\{opacity:0;transform:translate\(var\(--drift\),108vh\)/);
  assert.doesNotMatch(client, /playHeartCascade|call-reaction-heart/);
});

test('both the call reaction and a single-heart chat message use it; other emoji still float up', () => {
  assert.match(client, /if \(isHeartEmoji\(emoji\)\) \{ playHeartShower\(\); return; \}/);
  assert.match(client, /function triggerEmojiEffect\(emoji\) \{\s*if \(isHeartEmoji\(emoji\)\) \{ playHeartShower\(\); return; \}/);
  assert.match(client, /animation:emoji-float-up \$\{duration\}ms/);
});

test('an emoji received behind the iOS lock screen plays once after the chat becomes visible', () => {
  const played = [];
  const room = { code:'room-1' };
  const document = { hidden:true };
  const context = vm.createContext({
    document,
    tabFocused:false,
    quickLockActive:false,
    isRoomVisible: () => true,
    triggerEmojiEffect: emoji => played.push(emoji),
    requestAnimationFrame: callback => callback(),
    Date,
  });
  vm.runInContext(extract('handleIncomingEmojiEffect') + '\n' + extract('flushPendingEmojiEffect'), context);

  context.handleIncomingEmojiEffect(room, { id:'heart-1', kind:'text', jumbo:true, content:'❤️' });
  assert.equal(played.length, 0);
  assert.equal(room.pendingEmojiEffect.messageId, 'heart-1');

  document.hidden = false;
  context.tabFocused = true;
  assert.equal(context.flushPendingEmojiEffect(room), true);
  assert.deepEqual(played, ['❤️']);
  assert.equal(room.pendingEmojiEffect, null);
  assert.equal(context.flushPendingEmojiEffect(room), false, 'duplicate lifecycle events must not replay the shower');
});

test('an off-screen emoji is not saved for later while the user is active in another chat', () => {
  const room = { code:'room-2' };
  const context = vm.createContext({
    document:{ hidden:false },
    tabFocused:true,
    quickLockActive:false,
    isRoomVisible: () => false,
    triggerEmojiEffect: () => assert.fail('off-screen effect played'),
    requestAnimationFrame: callback => callback(),
    Date,
  });
  vm.runInContext(extract('handleIncomingEmojiEffect') + '\n' + extract('flushPendingEmojiEffect'), context);
  context.handleIncomingEmojiEffect(room, { id:'heart-2', kind:'text', jumbo:true, content:'❤️' });
  assert.equal(room.pendingEmojiEffect, undefined);
});
