'use strict';

// Swipe a message to the right to reply (WhatsApp style). The gesture only starts from a mostly horizontal,
// rightward drag, so scrolling, long-press selection, taps and the system back gesture are untouched.

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

function harness({ selectMode = false } = {}) {
  const listeners = {};
  const style = {};
  const el = {
    style, isConnected:true,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    getBoundingClientRect: () => ({ left:100, top:200, height:40 }),
  };
  const iconStyle = {}, iconClasses = new Set();
  const icon = { style:iconStyle, isConnected:true, classList:{ toggle: (name, on) => { on ? iconClasses.add(name) : iconClasses.delete(name); }, remove: name => iconClasses.delete(name) } };
  const vibrations = [];
  const context = vm.createContext({
    selectMode, lastLongPressAt:0, swipeReplyIcon:icon,
    SWIPE_REPLY_THRESHOLD_PX:56, SWIPE_REPLY_MAX_PX:92, SWIPE_REPLY_EDGE_PX:24,
    navigator:{ vibrate: ms => vibrations.push(ms) },
    document:{ createElement: () => icon, body:{ appendChild() {} } },
    Math, String, Date,
  });
  vm.runInContext('let swipeReplyIcon2;' + extractFunction('swipeReplyIconEl') + '\n' + extractFunction('attachSwipeToReply'), context);
  const replies = [];
  vm.runInContext('globalThis.attach = attachSwipeToReply', context);
  context.attach(el, () => replies.push('reply'));
  const touch = (x, y) => ({ clientX:x, clientY:y });
  const event = (x, y, extra = {}) => ({ touches:[touch(x, y)], changedTouches:[touch(x, y)], target:{ closest: () => null }, prevented:false, preventDefault() { this.prevented = true; }, ...extra });
  const swipe = (steps, { start = [150, 300] } = {}) => {
    const events = [];
    const down = event(...start); listeners.touchstart(down);
    for (const [x, y] of steps) { const move = event(x, y); listeners.touchmove(move); events.push(move); }
    const last = steps.length ? steps[steps.length - 1] : start;
    const up = event(...last); listeners.touchend(up);
    return { events, up };
  };
  return { context, listeners, el, style, replies, vibrations, icon, iconClasses, swipe, event };
}

test('a clear rightward swipe past the threshold opens the reply, once, and the row snaps back', () => {
  const h = harness();
  const { events, up } = h.swipe([[170, 302], [200, 303], [250, 305]]);
  assert.equal(h.replies.length, 1);
  assert.equal(events.every(move => move.prevented), true, 'a locked swipe stops the page scrolling or navigating');
  assert.equal(h.style.transform, '', 'the row returns to its place');
  assert.equal(up.prevented, true, 'the lift is not also a tap on a photo or link');
  assert.ok(h.context.lastLongPressAt > 0, 'taps right after a swipe are ignored');
  assert.deepEqual(h.vibrations, [10], 'one tick when the threshold is passed');
});

test('while dragging, the row follows the finger with resistance and stops at the maximum', () => {
  const h = harness();
  h.listeners.touchstart(h.event(150, 300));
  h.listeners.touchmove(h.event(190, 302));
  const early = parseFloat(/translateX\(([\d.]+)px\)/.exec(h.style.transform)[1]);
  h.listeners.touchmove(h.event(600, 302));
  const far = parseFloat(/translateX\(([\d.]+)px\)/.exec(h.style.transform)[1]);
  assert.ok(early > 0 && early < 40 * 0.85 + 0.01);
  assert.equal(far, 92);
  assert.equal(h.iconClasses.has('ready'), true);
});

test('a short swipe does not reply, and snaps back', () => {
  const h = harness();
  h.swipe([[165, 301], [185, 302], [195, 302]]);
  assert.equal(h.replies.length, 0);
  assert.equal(h.style.transform, '');
});

test('vertical movement is a scroll: nothing is dragged, prevented or sent', () => {
  const h = harness();
  const { events } = h.swipe([[152, 330], [155, 380], [200, 420]]);
  assert.equal(h.replies.length, 0);
  assert.equal(events.some(move => move.prevented), false);
  assert.equal(h.style.transform, undefined);
});

test('a leftward swipe, or a mostly diagonal one, is not a reply', () => {
  const left = harness();
  left.swipe([[120, 300], [60, 301], [30, 301]]);
  assert.equal(left.replies.length, 0);
  const diagonal = harness();
  diagonal.swipe([[175, 330], [200, 360], [260, 420]]);
  assert.equal(diagonal.replies.length, 0);
});

test('a swipe cannot begin in the left-edge back-gesture zone, in selection mode, or on a control', () => {
  const edge = harness();
  edge.swipe([[40, 300], [120, 302], [200, 303]], { start:[10, 300] });
  assert.equal(edge.replies.length, 0);
  const selecting = harness({ selectMode:true });
  selecting.swipe([[170, 302], [200, 303], [250, 305]]);
  assert.equal(selecting.replies.length, 0);
  const onControl = harness();
  onControl.listeners.touchstart({ touches:[{ clientX:150, clientY:300 }], target:{ closest: () => ({}) } });
  onControl.listeners.touchmove(onControl.event(250, 302));
  onControl.listeners.touchend(onControl.event(250, 302));
  assert.equal(onControl.replies.length, 0);
});

test('a cancelled touch resets without replying', () => {
  const h = harness();
  h.listeners.touchstart(h.event(150, 300));
  h.listeners.touchmove(h.event(260, 302));
  h.listeners.touchcancel();
  assert.equal(h.replies.length, 0);
  assert.equal(h.style.transform, '');
  h.listeners.touchend(h.event(260, 302));
  assert.equal(h.replies.length, 0, 'the finger lifting afterwards does nothing');
});

test('wired for every message that can be replied to; it replies exactly like the selection bar', () => {
  const wire = extractFunction('wireMsgActions');
  assert.match(wire, /if \(messageReplyable\(rec\)\) \{\s*attachSwipeToReply\(div, \(\) => \{\s*if \(selectMode\) return;\s*startReply\(rec, msgId, replyText\);\s*document\.getElementById\('msg-input'\)\?\.focus\(\{ preventScroll:true \}\);/);
  assert.match(extractFunction('directSelectionController'), /startReply\(one\.entry\.rec, one\.id, one\.entry\.replyText\);\s*document\.getElementById\('msg-input'\)\?\.focus\(\{ preventScroll: true \}\);/);
});

test('in the native apps a right swipe that starts on a message replies instead of going back', () => {
  assert.match(extractFunction('nativeSwipeNavigationBlocked'), /\.group-message, #chat-body \.msg'\)/);
});

test('the same swipe replies in a private group, and is off while group messages are being selected', () => {
  const groups = fs.readFileSync(path.join(__dirname, '..', 'client', 'groups.js'), 'utf8');
  const wire = groups.slice(groups.indexOf('function wirePrivateGroupMessage(row)'), groups.indexOf('function jumpToPrivateGroupMessage'));
  assert.match(wire, /attachSwipeToReply\(card, \(\) => \{ if \(!groupSelectMode\) startPrivateGroupReply\(id\); \}, \(\) => groupSelectMode\);/);
  // The helper takes the "blocked" test as a parameter, defaulting to the direct chat's selection mode.
  assert.match(client, /function attachSwipeToReply\(el, onReply, blocked = \(\) => selectMode\) \{/);

  const h = harness({ selectMode:true });
  let groupSelecting = false;
  const replies = [];
  h.context.attach(h.el, () => replies.push('group'), () => groupSelecting);
  h.listeners.touchstart(h.event(150, 300));
  h.listeners.touchmove(h.event(250, 303));
  h.listeners.touchend(h.event(250, 303));
  assert.deepEqual(replies, ['group'], 'direct selectMode does not block the group wiring; its own flag does');
  groupSelecting = true;
  h.listeners.touchstart(h.event(150, 300));
  h.listeners.touchmove(h.event(250, 303));
  h.listeners.touchend(h.event(250, 303));
  assert.deepEqual(replies, ['group']);
});
