'use strict';

// Two iOS-app keyboard behaviors that live in the page rather than the Swift
// wrapper: opening the keyboard when a 1:1 chat is tapped (like Snapchat), and
// scrolling a focused form field out from under the keyboard (the Username box
// on the signup screen). The native web view shrinks to the area above the
// keyboard only after WebKit has decided the field was visible, so nothing
// scrolled the field back into view.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('fieldNeedsReveal: a field under the keyboard (or above the top) needs scrolling, a visible one does not', () => {
  const fieldNeedsReveal = vm.runInNewContext(`(${extract(client, 'fieldNeedsReveal')})`, {});
  const viewport = 420; // web view height with the keyboard up
  assert.equal(fieldNeedsReveal({ top:480, bottom:540 }, viewport), true, 'fully under the keyboard');
  assert.equal(fieldNeedsReveal({ top:390, bottom:430 }, viewport), true, 'partly under the keyboard');
  assert.equal(fieldNeedsReveal({ top:100, bottom:160 }, viewport), false, 'comfortably visible');
  assert.equal(fieldNeedsReveal({ top:-20, bottom:30 }, viewport), true, 'scrolled above the top');
  assert.equal(fieldNeedsReveal(null, viewport), false);
});

test('the focused-field reveal is iOS-app only and leaves the chat composers to the chat layout', () => {
  const start = client.indexOf('(function revealFieldsAboveKeyboard()');
  assert.notEqual(start, -1);
  const block = client.slice(start, client.indexOf('})();', start));
  assert.match(block, /if \(!isNativeIOS\(\)\) return;/);
  assert.match(block, /new Set\(\['msg-input', 'group-message-input'\]\)/);
  assert.match(block, /document\.addEventListener\('focusin'/);
  assert.match(block, /scrollIntoView\(\{ block:'center'/);
  assert.match(block, /\[150, 400, 800\]/);
});

function openChatHarness({ native = true, disabled = false, active = true } = {}) {
  const calls = [], pins = [], timers = [];
  const input = { disabled, readOnly:false, focus:options => calls.push(['focus', options]) };
  let groupOpen = true;
  const groupInput = { disabled, readOnly:false, focus:options => calls.push(['group-focus', options]) };
  const setGroupOpen = value => { groupOpen = value; };
  const context = vm.createContext({
    isNativeIOS: () => native, pins, clearStaleCallKeyboardGuard: () => false, setTimeout: (fn, ms) => { timers.push([ms, fn]); },
    chatKeyboardLayout: { pin: () => pins.push('pin') },
    document: { getElementById: id => id === 'msg-input' ? input
      : id === 'group-message-input' ? groupInput
      : id === 's-chat' ? { classList:{ contains:name => name === 'active' && active } }
      : id === 'group-chat' ? { classList:{ contains:name => name === 'open' && groupOpen } } : null },
  });
  vm.runInContext(extract(client, 'pinChatAgainAfterKeyboardResize'), context);
  vm.runInContext(extract(client, 'focusComposerOnOpenFromTap'), context);
  vm.runInContext(extract(client, 'focusGroupComposerOnOpenFromTap'), context);
  return { context, calls, pins, timers, input, setGroupOpen };
}

test('tapping a 1:1 chat in the iOS app focuses the message box so the keyboard opens', () => {
  const { context, calls } = openChatHarness();
  context.focusComposerOnOpenFromTap();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].preventScroll, true);
});

test('no automatic keyboard outside the iOS app, for a disabled composer, or when the chat is not showing', () => {
  for (const options of [{ native:false }, { disabled:true }, { active:false }]) {
    const { context, calls } = openChatHarness(options);
    context.focusComposerOnOpenFromTap();
    assert.equal(calls.length, 0, JSON.stringify(options));
  }
});

test('the focus happens synchronously in the inbox-row tap, only after the chat actually opened', () => {
  const fn = extract(client, 'openVaultListRoom');
  assert.match(fn, /if \(openConversationAfterPaint\(code\)\) focusComposerOnOpenFromTap\(\);/);
  // Rooms still restoring have a disabled composer; they keep the plain open.
  assert.match(fn, /if \(room\?\.restorePending\) \{[\s\S]*?openConversationAfterPaint\(code\);\s*\} else if/);
});

test('after the tap, the newest message is pinned again once the native keyboard resize has landed', () => {
  const { context, pins, timers } = openChatHarness();
  context.focusComposerOnOpenFromTap();
  assert.deepEqual(timers.map(([ms]) => ms), [350, 700, 1100]);
  assert.equal(pins.length, 0, 'nothing pinned synchronously — the shrink has not happened yet');
  for (const [, fn] of timers) fn();
  assert.equal(pins.length, 3);
});

test('a delayed re-pin does nothing if the person already left the chat', () => {
  const { context, pins, timers } = openChatHarness();
  context.focusComposerOnOpenFromTap();
  context.document.getElementById = id => id === 's-chat' ? { classList:{ contains:() => false } } : null;
  for (const [, fn] of timers) fn();
  assert.equal(pins.length, 0);
});

test('tapping a group in the iOS app opens the keyboard and pins its newest message after the native resize', () => {
  const { context, calls, pins, timers } = openChatHarness();
  context.focusGroupComposerOnOpenFromTap();
  assert.deepEqual(calls.map(([name]) => name), ['group-focus']);
  assert.deepEqual(timers.map(([ms]) => ms), [350, 700, 1100]);
  for (const [, fn] of timers) fn();
  assert.equal(pins.length, 3);
});

test('no automatic group keyboard outside the iOS app, for a closed group, or after leaving it', () => {
  const web = openChatHarness({ native:false });
  web.context.focusGroupComposerOnOpenFromTap();
  assert.equal(web.calls.length, 0);
  const closed = openChatHarness();
  closed.setGroupOpen(false);
  closed.context.focusGroupComposerOnOpenFromTap();
  assert.equal(closed.calls.length, 0);
  const left = openChatHarness();
  left.context.focusGroupComposerOnOpenFromTap();
  left.setGroupOpen(false);
  for (const [, fn] of left.timers) fn();
  assert.equal(left.pins.length, 0);
});

test('the group inbox-row tap focuses the composer synchronously after opening the group', () => {
  assert.match(client, /openPrivateGroup\(el\.dataset\.group\); focusGroupComposerOnOpenFromTap\(\);/);
});

// While a call is up the iOS wrapper blurs #msg-input and marks it readOnly
// (dataset.vaultlixCallKeyboardGuard) so the keyboard cannot cover the call UI.
// Several call-ending paths never lifted that again, so after a cancelled or
// unanswered call the composer stayed readOnly: taps on "Type a message" did
// nothing ("freezes") and iOS floated an AutoFill pill instead of the keyboard.
function guardHarness({ guarded = true, roomStates = ['idle'] } = {}) {
  const input = { readOnly:true, dataset:guarded ? { vaultlixCallKeyboardGuard:'1' } : {} };
  const context = vm.createContext({
    document: { getElementById: id => id === 'msg-input' ? input : null },
    rooms: new Map(roomStates.map((callState, index) => [String(index), { callState }])),
  });
  vm.runInContext(extract(client, 'clearStaleCallKeyboardGuard'), context);
  return { context, input };
}

test('a call keyboard guard left on after the call ended is lifted so the composer opens the keyboard again', () => {
  const { context, input } = guardHarness({ roomStates:['idle', 'idle'] });
  assert.equal(context.clearStaleCallKeyboardGuard(), true);
  assert.equal(input.readOnly, false);
  assert.equal('vaultlixCallKeyboardGuard' in input.dataset, false);
});

test('the guard stays while a call is genuinely in progress, and a normal readOnly composer is untouched', () => {
  const live = guardHarness({ roomStates:['idle', 'active'] });
  assert.equal(live.context.clearStaleCallKeyboardGuard(), false);
  assert.equal(live.input.readOnly, true);
  const ringing = guardHarness({ roomStates:['incoming'] });
  assert.equal(ringing.context.clearStaleCallKeyboardGuard(), false);
  const unguarded = guardHarness({ guarded:false });
  assert.equal(unguarded.context.clearStaleCallKeyboardGuard(), false);
  assert.equal(unguarded.input.readOnly, true, 'only the wrapper\'s own guard is ever lifted');
});

test('tapping the composer, or opening a chat from the inbox, clears a stale guard first', () => {
  assert.match(client, /for \(const type of \['touchstart', 'pointerdown'\]\) \{\s*document\.addEventListener\(type, event => \{\s*if \(event\.target\?\.closest\?\.\('#msg-input'\)\) clearStaleCallKeyboardGuard\(\);\s*\}, \{ capture:true, passive:true \}\);/);
  const fn = extract(client, 'focusComposerOnOpenFromTap');
  assert.ok(fn.indexOf('clearStaleCallKeyboardGuard()') > 0 && fn.indexOf('clearStaleCallKeyboardGuard()') < fn.indexOf("getElementById('msg-input')"));
});

test('the native call manager releases the keyboard lock whenever the last call disappears', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
  assert.match(app, /private var calls: \[UUID: \[String: Any\]\] = \[:\] \{\s*didSet \{\s*guard calls\.isEmpty, appKeyboardLockedForCall else \{ return \}\s*DispatchQueue\.main\.async \{ \[weak self\] in self\?\.releaseAppKeyboardIfIdle\(\) \}/);
});
