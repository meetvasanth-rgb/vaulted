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

// ── Queueing and the native iOS permission handshake ──
// The whole playback block is extracted and run with a controllable page: visibility flags, a fake
// window that records bridge messages and listeners, and manual timers.
function playbackHarness({ native = false, capable = false, visible = true } = {}) {
  const start = client.indexOf('// ── EMOJI EFFECT PLAYBACK');
  const end = client.indexOf('// ── END EMOJI EFFECT PLAYBACK');
  assert.ok(start > 0 && end > start);
  const played = [], bridge = [], listeners = {}, timers = [];
  const cover = { classList:{ shown:false, contains(name) { return name === 'show' && this.shown; } } };
  const window = {
    addEventListener: (type, fn) => { listeners[type] = fn; },
    webkit: { messageHandlers: { vaultlixCall: { postMessage: message => bridge.push(message) } } },
  };
  const rooms = new Map();
  const context = vm.createContext({
    window, rooms, Date, Math, Map, Set,
    document: { hidden:false, hasFocus: () => true, getElementById: id => id === 'privacy-cover' ? cover : null },
    tabFocused:true, quickLockActive:false, nativeIOSLifecycleKnown:false, nativeIOSAppActive:true,
    isNativeIOS: () => native,
    isRoomVisible: room => visible && room.code === 'room-1',
    triggerEmojiEffect: emoji => played.push(emoji),
    requestAnimationFrame: callback => callback(),
    setTimeout: (fn, ms) => { const timer = { fn, ms, cleared:false }; timers.push(timer); return timer; },
    clearTimeout: timer => { if (timer) timer.cleared = true; },
  });
  vm.runInContext(client.slice(start, end), context);
  const room = { code:'room-1' };
  rooms.set(room.code, room);
  if (capable) listeners['vaultlix:emoji-effect-capability']({ detail:{ available:true } });
  const heart = id => ({ id, kind:'text', jumbo:true, content:'\u2764\uFE0F' });
  const answer = (index, allowed) => listeners['vaultlix:emoji-effect-permission']({ detail:{ requestId:bridge[index].requestId, allowed } });
  return { context, room, rooms, played, bridge, listeners, timers, cover, heart, answer };
}

test('an effect that arrives while the page is hidden or covered is queued, and plays once when visible again', () => {
  const h = playbackHarness();
  h.context.document.hidden = true;
  h.context.tabFocused = false;
  h.context.handleIncomingEmojiEffect(h.room, h.heart('m1'));
  assert.equal(h.played.length, 0);
  assert.equal(h.room.pendingEmojiEffect.messageId, 'm1');
  assert.equal(h.context.flushPendingEmojiEffect(h.room), false, 'still hidden');

  h.context.document.hidden = false;
  h.context.tabFocused = true;
  assert.equal(h.context.flushPendingEmojiEffect(h.room), true);
  assert.deepEqual(h.played, ['\u2764\uFE0F']);
  assert.equal(h.room.pendingEmojiEffect, null);
  assert.equal(h.context.flushPendingEmojiEffect(h.room), false, 'duplicate lifecycle events must not replay it');
  h.context.handleIncomingEmojiEffect(h.room, h.heart('m1'));
  assert.equal(h.played.length, 1, 'the same message never plays twice');
});

test('App Lock holds an effect until the unlock replays it', () => {
  const h = playbackHarness();
  h.context.quickLockActive = true;
  h.context.handleIncomingEmojiEffect(h.room, h.heart('locked'));
  assert.equal(h.played.length, 0);
  assert.equal(h.room.pendingEmojiEffect.messageId, 'locked');
  h.context.quickLockActive = false;
  h.context.flushPendingEmojiEffect(h.room);
  assert.equal(h.played.length, 1);
});

test('a heart for a chat that is not open (another chat or the inbox is showing) is kept and plays when that chat is opened', () => {
  const h = playbackHarness({ visible:false });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('elsewhere'));
  assert.equal(h.played.length, 0, 'nothing plays over the chat that is open');
  assert.equal(h.room.pendingEmojiEffect.messageId, 'elsewhere');
  assert.equal(h.bridge.length, 0);

  // Opening the conversation (the chat screen is shown) replays it, once.
  h.context.isRoomVisible = room => room.code === 'room-1';
  assert.equal(h.context.flushPendingEmojiEffect(h.room), true);
  assert.deepEqual(h.played, ['\u2764\uFE0F']);
  assert.equal(h.context.flushPendingEmojiEffect(h.room), false);
  assert.equal(h.played.length, 1);
});

test('on iOS the same open-the-chat replay goes through the native permission first', () => {
  const h = playbackHarness({ native:true, capable:true, visible:false });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('ios-elsewhere'));
  assert.equal(h.bridge.length, 0, 'not asked while the chat is not open');
  h.context.isRoomVisible = room => room.code === 'room-1';
  assert.equal(h.context.flushPendingEmojiEffect(h.room), true);
  assert.equal(h.played.length, 0, 'not before native says yes');
  h.answer(0, true);
  assert.equal(h.played.length, 1);
});

test('a queued effect waits for its conversation to be on screen, then plays after it opens', () => {
  const h = playbackHarness({ visible:false });
  h.context.quickLockActive = true;
  h.context.handleIncomingEmojiEffect(h.room, h.heart('later'));
  h.context.quickLockActive = false;
  assert.equal(h.context.flushPendingEmojiEffect(h.room), false, 'the conversation is not open yet');
  assert.equal(h.room.pendingEmojiEffect.messageId, 'later');
  h.context.isRoomVisible = room => room.code === 'room-1';
  assert.equal(h.context.flushPendingEmojiEffect(h.room), true);
  assert.equal(h.played.length, 1);
});

test('the newest queued effect wins and a very old one is discarded', () => {
  const h = playbackHarness();
  h.context.quickLockActive = true;
  h.context.handleIncomingEmojiEffect(h.room, h.heart('first'));
  h.context.handleIncomingEmojiEffect(h.room, h.heart('second'));
  assert.equal(h.room.pendingEmojiEffect.messageId, 'second');
  h.context.quickLockActive = false;
  h.room.pendingEmojiEffect.queuedAt = Date.now() - 31 * 60 * 1000;
  assert.equal(h.context.flushPendingEmojiEffect(h.room), false);
  assert.equal(h.room.pendingEmojiEffect, null);
  assert.equal(h.played.length, 0);
});

test('the native iOS scene state and cover override a page that still claims to be visible', () => {
  const h = playbackHarness();
  h.context.nativeIOSLifecycleKnown = true;
  h.context.nativeIOSAppActive = false;
  h.context.handleIncomingEmojiEffect(h.room, h.heart('inactive'));
  assert.equal(h.played.length, 0);
  assert.equal(h.context.flushPendingEmojiEffect(h.room), false);
  h.context.nativeIOSAppActive = true;
  assert.equal(h.context.flushPendingEmojiEffect(h.room), true);

  const covered = playbackHarness({ native:true });
  covered.cover.classList.shown = true;
  covered.context.handleIncomingEmojiEffect(covered.room, covered.heart('covered'));
  assert.equal(covered.played.length, 0);
  assert.equal(covered.room.pendingEmojiEffect.messageId, 'covered');
});

test('Android, browsers and older apps play immediately when visible, without asking native', () => {
  for (const options of [{ native:false, capable:false }, { native:true, capable:false }, { native:false, capable:true }]) {
    const h = playbackHarness(options);
    h.context.handleIncomingEmojiEffect(h.room, h.heart('now'));
    assert.deepEqual(h.played, ['\u2764\uFE0F'], JSON.stringify(options));
    assert.equal(h.bridge.length, 0, JSON.stringify(options));
  }
});

test('on iOS with the wrapper handshake, nothing plays before native says yes', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('ask'));
  assert.equal(h.played.length, 0, 'not before permission');
  assert.equal(h.bridge.length, 1);
  assert.equal(h.bridge[0].action, 'requestEmojiEffectPermission');
  assert.match(h.bridge[0].requestId, /^[A-Za-z0-9-]{8,80}$/);
  h.answer(0, true);
  assert.deepEqual(h.played, ['\u2764\uFE0F']);
});

test('a "not allowed" answer leaves it queued; a later "allowed" plays it exactly once', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('denied'));
  h.answer(0, false);
  assert.equal(h.played.length, 0);
  assert.equal(h.room.pendingEmojiEffect.messageId, 'denied');

  // The app becomes active again: the retry asks again and is allowed.
  assert.equal(h.context.flushPendingEmojiEffect(h.room), true);
  assert.equal(h.bridge.length, 2);
  h.answer(1, true);
  assert.equal(h.played.length, 1);
  assert.equal(h.room.pendingEmojiEffect, null);

  // Duplicate or replayed answers and further flushes can never play it again.
  h.answer(1, true);
  h.context.flushPendingEmojiEffect(h.room);
  h.context.handleIncomingEmojiEffect(h.room, h.heart('denied'));
  assert.equal(h.played.length, 1);
  assert.equal(h.bridge.length, 2);
});

test('a "yes" that arrives after the app went inactive again does not play behind the cover', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('race'));
  h.context.nativeIOSLifecycleKnown = true;
  h.context.nativeIOSAppActive = false;
  h.answer(0, true);
  assert.equal(h.played.length, 0);
  assert.equal(h.room.pendingEmojiEffect.messageId, 'race');
});

test('a missing answer times out and keeps the effect queued; repeated asks for one message are coalesced', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('silent'));
  h.context.flushPendingEmojiEffect(h.room);
  h.context.handleIncomingEmojiEffect(h.room, h.heart('silent'));
  assert.equal(h.bridge.length, 1, 'one outstanding request per message');
  const timeout = h.timers.find(timer => timer.ms === 2000 && !timer.cleared);
  timeout.fn();
  assert.equal(h.played.length, 0);
  assert.equal(h.room.pendingEmojiEffect.messageId, 'silent');
});

test('a late "yes" (the page was busy) is still honoured within the grace period, once', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('late'));
  h.timers.find(timer => timer.ms === 2000 && !timer.cleared).fn();
  assert.equal(h.played.length, 0);
  h.answer(0, true);
  assert.deepEqual(h.played, ['\u2764\uFE0F']);
  h.answer(0, true);
  assert.equal(h.played.length, 1, 'a repeated late answer cannot replay it');
});

test('an answer that arrives after the grace period is ignored', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('too-late'));
  h.timers.find(timer => timer.ms === 2000 && !timer.cleared).fn();
  h.timers.find(timer => timer.ms === 10000 && !timer.cleared).fn();
  h.answer(0, true);
  assert.equal(h.played.length, 0);
  assert.equal(h.room.pendingEmojiEffect.messageId, 'too-late');
});

test('a held effect asks again a few times by itself, then stops', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('retry'));
  h.answer(0, false); // not allowed yet
  const retryTimers = h.timers.filter(timer => timer.ms === 1200);
  assert.equal(retryTimers.length, 1);
  retryTimers[0].fn(); // the retry fires and asks native again
  assert.equal(h.bridge.length, 2, 'asked again');
  h.answer(1, true);
  assert.equal(h.played.length, 1);

  // Never more than five retries per effect.
  const capped = playbackHarness({ native:true, capable:true });
  capped.context.handleIncomingEmojiEffect(capped.room, capped.heart('capped'));
  for (let i = 0; i < 8; i++) {
    capped.answer(capped.bridge.length - 1, false);
    const next = capped.timers.filter(timer => timer.ms === 1200 && !timer.fired).at(-1);
    if (!next) break;
    next.fired = true;
    next.fn();
  }
  assert.ok(capped.bridge.length <= 6, `${capped.bridge.length} requests`);
  assert.equal(capped.played.length, 0);
});

test('every step is traced with its timestamp and the page and native state', () => {
  const h = playbackHarness({ native:true, capable:true });
  h.context.handleIncomingEmojiEffect(h.room, h.heart('trace'));
  h.answer(0, true);
  const trace = vm.runInContext('emojiEffectTrace', h.context);
  assert.deepEqual(JSON.parse(JSON.stringify(trace.map(entry => entry.stage))), ['incoming', 'permission-requested', 'permission-returned', 'played']);
  for (const entry of trace) {
    for (const key of ['t', 'hidden', 'focus', 'tabFocused', 'nativeKnown', 'nativeActive', 'appLock']) assert.ok(key in entry, `${entry.stage} lacks ${key}`);
  }
  assert.equal(h.context.window.__vaultlixEmojiTrace, trace);
});

test('the chat screen and the App Lock unlock both replay a queued effect', () => {
  assert.match(client, /if \(id === 's-chat'\) requestAnimationFrame\(\(\) => flushPendingEmojiEffect\(getActiveRoom\(\)\)\);/);
  const unlock = client.slice(client.indexOf('function completeQuickUnlock()'), client.indexOf('function updateAppLockStatus()'));
  assert.match(unlock, /flushPendingEmojiEffect\(getActiveRoom\(\)\)/);
  assert.match(client, /if \(active\) requestAnimationFrame\(\(\) => flushPendingEmojiEffect\(active\)\);/);
});

test('the iOS wrapper answers permission requests from the real scene state, and still sends app-state events', () => {
  const sceneDelegate = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
  assert.match(sceneDelegate, /if action == "ready"[\s\S]*emit\(name: "vaultlix:app-state"/);
  assert.match(sceneDelegate, /emit\(name: "vaultlix:emoji-effect-capability", detail: \["available": true\]\)/);
  const handler = sceneDelegate.slice(sceneDelegate.indexOf('if action == "requestEmojiEffectPermission"'), sceneDelegate.indexOf('if action == "startSpeechToText"'));
  assert.match(handler, /message\.frameInfo\.isMainFrame/);
  assert.match(handler, /requestId\.range\(of: "\^\[A-Za-z0-9-\]\{8,80\}\$", options: \.regularExpression\) != nil/);
  assert.match(handler, /windowScene\?\.activationState == \.foregroundActive/);
  assert.match(handler, /UIApplication\.shared\.applicationState == \.active/);
  assert.match(handler, /appSwitcherPrivacyCover == nil/);
  assert.match(handler, /emit\(name: "vaultlix:emoji-effect-permission", detail: \["requestId": requestId, "allowed": allowed\]\)/);
  assert.match(sceneDelegate, /func sceneWillResignActive[\s\S]*emit\(name: "vaultlix:app-state", detail: \["active": false\]\)/);
  assert.match(sceneDelegate, /func sceneDidBecomeActive[\s\S]*emit\(name: "vaultlix:app-state", detail: \["active": true\]\)/);
});
