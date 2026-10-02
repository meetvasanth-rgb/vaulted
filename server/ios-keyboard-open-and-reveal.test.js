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
  const calls = [];
  const input = { disabled, readOnly:false, focus:options => calls.push(['focus', options]) };
  const context = vm.createContext({
    isNativeIOS: () => native,
    document: { getElementById: id => id === 'msg-input' ? input : id === 's-chat' ? { classList:{ contains:name => name === 'active' && active } } : null },
  });
  vm.runInContext(extract(client, 'focusComposerOnOpenFromTap'), context);
  return { context, calls };
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
