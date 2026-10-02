'use strict';

// The iPhone keyboard shrinks the visual viewport, pans the page and changes
// height again when the suggestion strip appears. These rules keep the composer
// above the keyboard and the newest message in view without yanking a reader
// who scrolled up. The environment is simulated; the real keyboard needs a phone.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const iosScene = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
const capacitorConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'capacitor.config.json'), 'utf8'));
const iosCapacitorConfig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'capacitor.config.json'), 'utf8'));

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
const factory = vm.runInNewContext(`(${extract(client, 'createChatKeyboardLayout')})`, {});

function setup({ chat = 'direct', innerHeight = 800, nativeResize = false } = {}) {
  const listeners = { vv:{}, win:{}, doc:{} };
  const mk = (id, extra = {}) => {
    const classes = new Set();
    return { id, style:{}, offsetHeight:0,
      classList:{ contains:name => !!extra[name] || classes.has(name), add:name => classes.add(name), remove:name => classes.delete(name) }, ...extra };
  };
  const directList = { id:'chat-body', scrollTop:0, scrollHeight:1000, clientHeight:500 };
  const groupList = { id:'group-chat-body', scrollTop:0, scrollHeight:1000, clientHeight:500 };
  const els = {
    's-chat': mk('s-chat', { active: chat === 'direct' }),
    'group-chat': mk('group-chat', { open: chat === 'group' }),
    'chat-body': directList, 'group-chat-body': groupList,
  };
  const vv = { height:800, offsetTop:0, pageTop:0,
    addEventListener:(type, fn) => { listeners.vv[type] = fn; } };
  const win = { innerHeight, scrollY:0, addEventListener:(type, fn) => { listeners.win[type] = fn; } };
  const doc = { getElementById:id => els[id] || null, addEventListener:(type, fn) => { listeners.doc[type] = fn; } };
  const queue = [];
  const remembered = [];
  const layout = factory({ vv, win, doc, nativeResize, remember:height => remembered.push(height), schedule:(fn, ms) => { const t = { fn, ms, cancelled:false }; queue.push(t); return t; }, cancel:t => { t.cancelled = true; } });
  layout.start();
  const flush = () => { for (const t of queue.splice(0)) if (!t.cancelled) t.fn(); };
  // Only the pin-after-settling timers (0/120/320/650 ms), not the hold and animation timers.
  const flushSettle = () => { for (const t of queue.filter(item => !item.cancelled && [0, 120, 320, 650].includes(item.ms))) { t.cancelled = true; t.fn(); } };
  const list = chat === 'direct' ? directList : groupList;
  return { layout, listeners, els, vv, win, list, flush, flushSettle, queue, remembered };
}

test('with the keyboard up the chat is sized to the visible area and follows the panned viewport', () => {
  const t = setup();
  t.vv.height = 430; t.vv.pageTop = 120;
  t.listeners.vv.resize(); t.flush();
  assert.equal(t.els['s-chat'].style.height, '430px');
  assert.equal(t.els['s-chat'].style.minHeight, '430px', 'the screen class has min-height:100dvh which would otherwise win');
  assert.equal(t.els['s-chat'].style.transform, 'translateY(120px)');
});

test('the newest message is shown after the keyboard opens, and again after the animation settles', () => {
  const t = setup();
  t.list.scrollTop = 500; t.listeners.doc.scroll({ target:t.list }); // at the bottom
  t.vv.height = 430;
  t.listeners.vv.resize();
  t.list.scrollHeight = 1000; t.flush();
  assert.equal(t.list.scrollTop, 1000);
  // the suggestion strip makes the keyboard taller: layout changes again
  t.vv.height = 386; t.list.scrollHeight = 1044; t.list.scrollTop = 600;
  t.listeners.vv.resize(); t.flush();
  assert.equal(t.els['s-chat'].style.height, '386px');
  assert.equal(t.list.scrollTop, 1044, 'pinned again after the second change');
});

test('someone reading older messages is not yanked to the bottom by a keyboard change', () => {
  const t = setup();
  t.list.scrollTop = 100; t.listeners.doc.scroll({ target:t.list }); // scrolled up
  t.vv.height = 430;
  t.listeners.vv.resize(); t.flush();
  assert.equal(t.list.scrollTop, 100);
});

test('focusing the composer always jumps to the latest message, even from further up', () => {
  const t = setup();
  t.list.scrollTop = 100; t.listeners.doc.scroll({ target:t.list });
  assert.equal(t.layout.isPinned(), false);
  t.listeners.doc.focusin({ target:{ id:'msg-input' } });
  t.vv.height = 430; t.flush();
  assert.equal(t.list.scrollTop, 1000);
});

test('focusing something else does not move the list', () => {
  const t = setup();
  t.list.scrollTop = 100; t.listeners.doc.scroll({ target:t.list });
  t.listeners.doc.focusin({ target:{ id:'search-box' } });
  t.flush();
  assert.equal(t.list.scrollTop, 100);
});

test('when the keyboard goes away the inline sizing is removed', () => {
  const t = setup();
  t.vv.height = 430; t.vv.pageTop = 90; t.listeners.vv.resize(); t.flush();
  t.vv.height = 800; t.vv.pageTop = 0; t.listeners.vv.resize(); t.flush();
  assert.equal(t.els['s-chat'].style.height, '');
  assert.equal(t.els['s-chat'].style.minHeight, '');
  assert.equal(t.els['s-chat'].style.transform, '');
});

test('a natively resized web view is left to the page (no double adjustment) but still follows the newest message', () => {
  const t = setup({ innerHeight:430 });
  t.vv.height = 430;
  t.list.scrollTop = 500; t.listeners.doc.scroll({ target:t.list });
  t.listeners.win.resize(); t.list.scrollHeight = 1000; t.flush();
  assert.equal(t.els['s-chat'].style.height, '');
  assert.equal(t.list.scrollTop, 1000);
});

test('the group chat is a fixed screen: its top and height follow the visible area', () => {
  const t = setup({ chat:'group' });
  t.vv.height = 430; t.vv.offsetTop = 60;
  t.listeners.vv.resize(); t.flush();
  const shell = t.els['group-chat'];
  assert.equal(shell.style.height, '430px');
  assert.equal(shell.style.top, '60px');
  assert.equal(shell.style.bottom, 'auto');
  assert.equal(t.list.scrollTop, 1000);
  t.vv.height = 800; t.vv.offsetTop = 0; t.listeners.vv.resize(); t.flush();
  assert.equal(shell.style.height, '');
  assert.equal(shell.style.top, '');
  assert.equal(shell.style.bottom, '');
});

test('opening a different conversation starts pinned to its newest message', () => {
  const t = setup();
  t.list.scrollTop = 100; t.listeners.doc.scroll({ target:t.list }); // scrolled up in the direct chat
  t.els['s-chat'].classList.contains = () => false;
  t.els['group-chat'].classList.contains = name => name === 'open';
  t.vv.height = 430; t.listeners.vv.resize(); t.flush();
  assert.equal(t.layout.isPinned(), true);
  assert.equal(t.els['group-chat-body'].scrollTop, 1000);
});

test('rapidly leaving and reopening a direct chat cannot reuse a hidden focused composer', () => {
  const showScreen = extract(client, 'showScreen');
  const setActiveRoom = extract(client, 'setActiveRoom');
  assert.match(showScreen, /if \(leavingChat\) \{[\s\S]*?getElementById\('msg-input'\)\?\.blur\(\)/);
  assert.match(showScreen, /classList\.remove\('composer-focused', 'kb-animating'\)/);
  assert.match(setActiveRoom, /enableInput\(!!\(room\.everOnline && room\.sharedKey && !room\.reconnectRequired\), false\)/);
  assert.doesNotMatch(setActiveRoom, /enableInput\([^\n]+, true\)/);
});

test('native iOS pins the active direct-chat shell to its resized web view', () => {
  assert.match(client, /html\.vaultlix-native-ios #s-chat\.active\{position:fixed!important;inset:0!important;[^}]*transform:none!important\}/);
});

test('pending settle passes are cancelled when a new change arrives', () => {
  const t = setup();
  t.vv.height = 430; t.listeners.vv.resize();
  const first = t.queue.slice();
  t.vv.height = 386; t.listeners.vv.resize();
  assert.ok(first.every(item => item.cancelled));
});

test('the page wires it to the real visual viewport, window and document', () => {
  assert.match(client, /createChatKeyboardLayout\(\{\s*vv: window\.visualViewport, win: window, doc: document,/);
  assert.match(client, /chatKeyboardLayout\.start\(\);/);
  assert.doesNotMatch(client, /chat\.style\.height = window\.visualViewport\.height \+ 'px';\s*\n\s*const body = document\.getElementById\('chat-body'\);\s*\n\s*if \(body\) body\.scrollTop = body\.scrollHeight;/);
});

// ── the keyboard is announced before the web view reports it ─────────────────
test('a native keyboard announcement shrinks the chat straight away, before any viewport report', () => {
  const t = setup({ chat:'group', innerHeight:800 });
  t.layout.keyboardWillShow(336);
  const shell = t.els['group-chat'];
  assert.equal(shell.style.height, '464px', 'the composer sits above where the keyboard is arriving');
  assert.equal(shell.style.minHeight, '464px');
  assert.equal(shell.style.top, '0px');
  assert.equal(shell.classList.contains('kb-animating'), true, 'it animates with the keyboard');
});

test('a viewport report that has not caught up yet does not undo the announced size', () => {
  const t = setup({ chat:'group' });
  t.layout.keyboardWillShow(336);
  t.vv.height = 800; // the web view still says "no keyboard"
  t.listeners.vv.resize(); t.listeners.doc.focusin({ target:{ id:'group-message-input' } });
  t.flushSettle();
  assert.equal(t.els['group-chat'].style.height, '464px');
});

test('once the web view reports the keyboard its exact numbers take over', () => {
  const t = setup({ chat:'group' });
  t.layout.keyboardWillShow(336);
  t.vv.height = 470; t.vv.offsetTop = 0;
  t.listeners.vv.resize(); t.flush();
  assert.equal(t.els['group-chat'].style.height, '470px');
});

test('the announced size is released after a moment when the web view resizes natively and never reports a keyboard', () => {
  const t = setup({ chat:'direct' });
  t.layout.keyboardWillShow(336);
  assert.equal(t.els['s-chat'].style.height, '464px');
  t.flush(); // the hold expires; the native resize means vv and innerHeight already agree
  assert.equal(t.els['s-chat'].style.height, '');
});

test('hiding: the chat grows back with the keyboard and a stale report cannot squash it again', () => {
  const t = setup({ chat:'group' });
  t.vv.height = 470; t.listeners.vv.resize(); t.flush();
  t.layout.keyboardWillHide();
  const growBack = () => { for (const item of t.queue.filter(x => !x.cancelled && x.ms === 140)) { item.cancelled = true; item.fn(); } };
  assert.equal(t.els['group-chat'].style.height, '470px', 'not yet: a keyboard that comes straight back is not a hide');
  growBack();
  assert.equal(t.els['group-chat'].style.height, '800px');
  t.listeners.doc.focusout({}); // the report still says the keyboard is up
  t.flushSettle();
  assert.equal(t.els['group-chat'].style.height, '800px');
  t.vv.height = 800; t.flush();
  assert.equal(t.els['group-chat'].style.height, '', 'then back to the normal layout');
});

test('the composer is still pinned to the newest message after an announcement', () => {
  const t = setup({ chat:'group' });
  t.list.scrollTop = 500; t.listeners.doc.scroll({ target:t.list });
  t.layout.keyboardWillShow(336);
  t.flush();
  assert.equal(t.list.scrollTop, 1000);
});

test('nonsense heights are ignored', () => {
  const t = setup({ chat:'group', innerHeight:800 });
  for (const height of [0, 50, NaN, undefined, 900]) t.layout.keyboardWillShow(height);
  assert.equal(t.els['group-chat'].style.height, undefined);
});

test('a browser without the native event starts from the height the keyboard had last time', () => {
  const listeners = {};
  const t = setup({ chat:'group' });
  const withEnv = (extra) => {
    const els = t.els;
    const doc = { getElementById:id => els[id] || null, addEventListener:(type, fn) => { listeners[type] = fn; } };
    const layout = factory({ vv:t.vv, win:t.win, doc, schedule:fn => ({ fn }), cancel:() => {}, ...extra });
    layout.start();
    return layout;
  };
  withEnv({ preShrinkOnFocus:true, recall:() => 300 });
  listeners.focusin({ target:{ id:'group-message-input' } });
  assert.equal(t.els['group-chat'].style.height, '500px');
  t.els['group-chat'].style.height = undefined;
  withEnv({ preShrinkOnFocus:false, recall:() => 300 });
  listeners.focusin({ target:{ id:'group-message-input' } });
  assert.equal(t.els['group-chat'].style.height, undefined, 'Android and the iOS app are left to their own events');
});

test('wiring: the app listens for the iOS keyboard events and the ring is off for both message boxes', () => {
  assert.match(client, /window\.addEventListener\('keyboardWillShow', willShow\)/);
  assert.match(client, /if \(isNativeIOS\(\) && plugin\?\.addListener\)/);
  assert.match(client, /plugin\.addListener\('keyboardWillHide', willHide\)/);
  assert.match(client, /preShrinkOnFocus: \/iP\(hone\|ad\|od\)\/\.test\(navigator\.userAgent\) && !isNativeIOS\(\),/);
  assert.match(client, /nativeResize: isNativeIOS\(\),/);
  const block = client.slice(client.lastIndexOf('<style>'));
  for (const selector of ['#msg-input:focus-visible', '#group-message-input:focus-visible', '#s-chat #msg-input:focus']) assert.ok(block.includes(selector), selector);
  assert.match(block, /outline:none!important;box-shadow:none!important/);
  assert.match(block, /#s-chat #msg-input:focus,#s-chat #msg-input:focus-visible\{background:#FBF8F9!important;border-color:#E3D6DB!important\}/);
  assert.match(block, /\.group-chat\.kb-animating,#s-chat\.kb-animating\{transition:height/);
});

test('native iOS pins immediately and follows through the animation without staged jumps', () => {
  const t = setup({ chat:'direct', innerHeight:800 });
  const nativeQueue = [];
  const layout = factory({
    vv:t.vv, win:t.win,
    doc:{ getElementById:id => t.els[id] || null, addEventListener:() => {} },
    nativeResize:true,
    schedule:(fn, ms) => { const item = { fn, ms, cancelled:false }; nativeQueue.push(item); return item; },
    cancel:item => { item.cancelled = true; },
  });
  layout.keyboardWillShow(336);
  assert.deepEqual(nativeQueue.filter(item => !item.cancelled && item.ms !== 900).map(item => item.ms), [0, 400, 0]);
  assert.equal(nativeQueue.some(item => !item.cancelled && [120, 320, 650].includes(item.ms)), false);
});

test('native keyboard wiring chooses one event channel instead of handling each event twice', () => {
  const blockStart = client.indexOf('(function listenForNativeKeyboard()');
  const blockEnd = client.indexOf('// ── LANDING ANIMATION', blockStart);
  const block = client.slice(blockStart, blockEnd);
  assert.match(block, /plugin\.addListener\('keyboardWillShow', willShow\);[^]*return;[^]*window\.addEventListener\('keyboardWillShow', willShow\);/);
  assert.doesNotMatch(block, /window\.addEventListener\('keyboardWillShow', willShow\);[^]*plugin\.addListener\('keyboardWillShow', willShow\)/);
});

test('while the chat eases to its new height the list keeps the newest message in view on every frame', () => {
  const t = setup({ chat:'group' });
  t.list.scrollTop = 500; t.listeners.doc.scroll({ target:t.list }); // at the bottom
  t.layout.keyboardWillShow(336);
  t.list.scrollTop = 0; // the list is left behind as the shell shrinks
  const frame = () => { const next = t.queue.filter(item => !item.cancelled && item.ms === 0); for (const item of next) { item.cancelled = true; item.fn(); } };
  t.list.scrollHeight = 1200;
  frame();
  assert.equal(t.list.scrollTop, 1200, 'followed on the next frame');
  t.list.scrollTop = 0; t.list.scrollHeight = 1250;
  frame();
  assert.equal(t.list.scrollTop, 1250, 'and the one after');
});

test('the following stops when the animation ends, and never yanks a reader who scrolled up', () => {
  const t = setup({ chat:'group' });
  t.list.scrollTop = 100; t.listeners.doc.scroll({ target:t.list }); // scrolled up
  t.layout.keyboardWillShow(336);
  const step = () => { for (const item of t.queue.filter(x => !x.cancelled && x.ms === 0)) { item.cancelled = true; item.fn(); } };
  t.list.scrollTop = 100; step();
  assert.equal(t.list.scrollTop, 100);
  for (const item of t.queue.filter(x => !x.cancelled && x.ms === 650)) { item.cancelled = true; item.fn(); } // settling over
  t.list.scrollTop = 500; t.listeners.doc.scroll({ target:t.list }); // back at the bottom
  step();
  assert.equal(t.list.scrollTop, 1000);
  for (const item of t.queue.filter(x => !x.cancelled && x.ms === 400)) { item.cancelled = true; item.fn(); } // animation over
  t.list.scrollTop = 0; step(); step();
  assert.equal(t.list.scrollTop, 0, 'no more per-frame pinning');
});

test('a small correction after the announcement eases in instead of snapping', () => {
  const t = setup({ chat:'group' });
  t.layout.keyboardWillShow(336);
  for (const item of t.queue.filter(x => x.ms === 400)) { item.cancelled = true; item.fn(); } // first animation over
  assert.equal(t.els['group-chat'].classList.contains('kb-animating'), false);
  t.vv.height = 448; t.vv.offsetTop = 0;   // the web view reports a slightly larger keyboard
  t.listeners.vv.resize();
  t.flushSettle();
  assert.equal(t.els['group-chat'].style.height, '448px');
});

test('the very first size after a keyboard report is applied at once, without animation', () => {
  const t = setup({ chat:'direct' });
  t.vv.height = 430; t.listeners.vv.resize(); t.flushSettle();
  assert.equal(t.els['s-chat'].style.height, '430px');
  assert.equal(t.els['s-chat'].classList.contains('kb-animating'), false);
});

test('the height the native keyboard announces is remembered for next time', () => {
  const t = setup({ chat:'group' });
  t.layout.keyboardWillShow(336);
  assert.deepEqual(t.remembered, [336]);
});

test('a browser iPhone can pre-shrink from memory and the announcement corrects it', () => {
  const t = setup({ chat:'group', innerHeight:800 });
  const listeners = {};
  const doc = { getElementById:id => t.els[id] || null, addEventListener:(type, fn) => { listeners[type] = fn; } };
  const layout = factory({ vv:t.vv, win:t.win, doc, schedule:fn => ({ fn }), cancel:() => {}, preShrinkOnFocus:true, recall:() => 300 });
  layout.start();
  listeners.focusin({ target:{ id:'group-message-input' } });
  assert.equal(t.els['group-chat'].style.height, '500px');
  layout.keyboardWillShow(336);
  assert.equal(t.els['group-chat'].style.height, '464px');
});

test('the native iOS wrapper owns the single keyboard resize', () => {
  assert.equal(capacitorConfig.plugins.Keyboard.resize, 'native');
  assert.equal(iosCapacitorConfig.plugins.Keyboard.resize, 'native');
  assert.equal(capacitorConfig.plugins.Keyboard.style, 'LIGHT');
  assert.equal(iosCapacitorConfig.plugins.Keyboard.style, 'LIGHT');
});

// keyboardWillShow() was updated to skip resizeShell() under native resize
// (Capacitor already shrinks the whole web view), but layout() — called
// independently on every visualViewport resize/scroll — kept deriving its
// own height and translateY from vv.height/vv.pageTop regardless of
// nativeResize. Under native resize, window.innerHeight shrinks together
// with the web view, but visualViewport can still transiently disagree with
// it mid-transition for reasons that have nothing to do with a keyboard
// overlay. When that happened, layout() applied a stale translateY on top
// of a web view iOS had already resized and positioned correctly, pushing
// the whole chat shell — including its header — out of view. This matches
// a real report: the peer name/header vanished above the keyboard on an
// iPhone 16, same build, while another device (whose visualViewport never
// transiently disagreed) looked fine.
test('under native resize, layout() never derives its own height or transform — iOS already positioned the web view', () => {
  const t = setup({ nativeResize:true });
  // Simulate exactly the transient mismatch that triggered the bug: iOS has
  // already resized the native web view (win.innerHeight shrank), but
  // visualViewport briefly reports a different height/pageTop mid-transition.
  t.win.innerHeight = 430;
  t.vv.height = 386;
  t.vv.pageTop = 120;
  t.listeners.vv.resize(); t.flush();
  assert.equal(t.els['s-chat'].style.height, undefined, 'no CSS height override — the native web view is already the right size');
  assert.equal(t.els['s-chat'].style.transform, undefined, 'no translateY — applying one here would shift the header off-screen on top of an already-correct native layout');
});

test('under native resize, keyboardWillShow skips resizeShell for the fixed group chat too', () => {
  const t = setup({ chat:'group', nativeResize:true });
  t.layout.keyboardWillShow(336);
  t.flush();
  assert.equal(t.els['group-chat'].style.height, undefined, 'resizeShell is skipped for native resize — only chat.fixed\'s top:0px (unrelated to sizing) still applies');
});

test('under native resize, the newest message follows the full keyboard animation', () => {
  const t = setup({ nativeResize:true });
  t.list.scrollTop = 500;
  t.listeners.doc.scroll({ target:t.list });
  t.layout.keyboardWillShow(336);

  // Run the first scheduled frame, then reproduce WebKit's synthetic scroll
  // after the native view has become shorter but before its animation ends.
  const firstFrame = t.queue.find(item => !item.cancelled && item.ms === 0);
  firstFrame.cancelled = true;
  firstFrame.fn();
  t.list.clientHeight = 220;
  t.list.scrollTop = 420;
  t.listeners.doc.scroll({ target:t.list });

  const nextFrame = t.queue.find(item => !item.cancelled && item.ms === 0);
  nextFrame.cancelled = true;
  nextFrame.fn();
  assert.equal(t.layout.isPinned(), true, 'the resize scroll is not mistaken for a reader scrolling up');
  assert.equal(t.list.scrollTop, 1000, 'the last message stays directly above the moving composer');
});

test('typing drops the bottom room kept for the home bar, and leaving the box gives it back', () => {
  const t = setup({ chat:'group' });
  t.listeners.doc.focusin({ target:{ id:'group-message-input' } });
  assert.equal(t.els['group-chat'].classList.contains('composer-focused'), true);
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), true);
  t.listeners.doc.focusout({ target:{ id:'some-other-field' } });
  assert.equal(t.els['group-chat'].classList.contains('composer-focused'), true, 'another field losing focus does not count');
  t.listeners.doc.focusout({ target:{ id:'group-message-input' } });
  assert.equal(t.els['group-chat'].classList.contains('composer-focused'), false);
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), false);
});

test('the styles remove that bottom room for both chats while typing', () => {
  assert.match(client, /#s-chat\.composer-focused \.chat-ftr,#s-chat\.composer-focused #chat-ftr\{padding-bottom:10px!important\}/);
  assert.match(client, /\.group-chat\.composer-focused \.group-chat-footer\{padding-bottom:10px\}/);
});

test('a keyboard that drops and comes straight back (Send on iPhone) does not make the chat jump', () => {
  const t = setup({ chat:'group' });
  t.layout.keyboardWillShow(336);
  for (const item of t.queue.filter(x => !x.cancelled && x.ms === 400)) { item.cancelled = true; item.fn(); }
  t.layout.keyboardWillHide();
  t.layout.keyboardWillShow(336);        // focus came straight back
  for (const item of t.queue.filter(x => !x.cancelled && x.ms === 140)) { item.cancelled = true; item.fn(); }
  assert.equal(t.els['group-chat'].style.height, '464px', 'never grew back to full height');
});

test('a resize scroll while the keyboard is opening is not mistaken for the reader scrolling up', () => {
  const t = setup({ chat:'group' });
  t.list.scrollTop = 500; t.listeners.doc.scroll({ target:t.list });   // at the bottom
  t.listeners.doc.focusin({ target:{ id:'group-message-input' } });     // tap the box
  t.list.scrollTop = 40;                                              // the list shrank under the reader
  t.listeners.doc.scroll({ target:t.list });                          // and the browser reports a scroll
  t.list.scrollHeight = 1300;
  t.flushSettle();
  assert.equal(t.list.scrollTop, 1300, 'the newest message is still brought into view');
});

test('a real scroll after the keyboard has settled still counts', () => {
  const t = setup({ chat:'group' });
  t.listeners.doc.focusin({ target:{ id:'group-message-input' } });
  t.flushSettle();
  t.list.scrollTop = 100; t.listeners.doc.scroll({ target:t.list });
  t.vv.height = 430; t.listeners.vv.resize(); t.flushSettle();
  assert.equal(t.list.scrollTop, 100);
});

test('wiring: Send keeps focus in the message box on touch screens', () => {
  const fn = extract(client, 'keepKeyboardOnTap');
  assert.match(fn, /addEventListener\('touchstart'[^]*preventDefault[^]*\{ passive:false \}/);
  assert.match(fn, /addEventListener\('touchend'[^]*button\.click\(\)/);
  assert.match(fn, /addEventListener\('mousedown', event => event\.preventDefault\(\)\)/);
  assert.match(client, /keepKeyboardOnTap\(document\.getElementById\('send-btn'\)\);\s*keepKeyboardOnTap\(document\.querySelector\('\.group-send-btn'\)\);/);
});

test('the iOS app asks for the light keyboard, and any exposed page area is white', () => {
  assert.match(client, /Keyboard\?\.setStyle\(\{ style:'LIGHT' \}\)/);
  assert.match(client, /\nhtml\{background:#fff\}\n/);
});

test('the iOS wrapper removes the inconsistent WKWebView form-navigation strip', () => {
  assert.match(iosScene, /inputAssistantItem\.leadingBarButtonGroups = \[\]/);
  assert.match(iosScene, /inputAssistantItem\.trailingBarButtonGroups = \[\]/);
  assert.match(iosScene, /forName: UIResponder\.keyboardWillShowNotification/);
  assert.match(iosScene, /suppressKeyboardInputAssistant\(in: bridgeController\?\.webView\)/);
  assert.match(iosScene, /for subview in view\.subviews \{\s*suppressKeyboardInputAssistant\(in: subview\)/);
  assert.match(iosScene, /let responderClass: AnyClass = type\(of: responder\)/);
  assert.match(iosScene, /guard className\.contains\("WKContent"\)/);
  assert.match(iosScene, /#selector\(getter: UIResponder\.inputAccessoryView\)/);
  assert.match(iosScene, /#selector\(getter: UIResponder\.inputAccessoryViewController\)/);
  assert.match(iosScene, /class_addMethod\(responderClass, viewSelector, nilAccessory, "@@:"\)/);
  assert.match(iosScene, /class_addMethod\(responderClass, controllerSelector, nilAccessoryController, "@@:"\)/);
  assert.doesNotMatch(iosScene, /reloadInputViews\(\)/);
});

// markComposerFocus() drops the footer's home-bar padding (see the comment
// above it), which resizes the footer — a real layout change. Previously this
// ran the instant the input was tapped, a beat before the native keyboard
// event and Capacitor's own view resize. Two uncoordinated layout passes
// landing inside one transition produced a visible double-image/ghost frame
// on real devices: the keyboard appeared correctly, then ~150ms later the
// composer and the last couple of messages vanished behind a blurred ghost
// of the keyboard before the correct layout caught up a moment later.
// Android has no such split (one native resize owns the whole transition),
// which is why it was never affected. Folding markComposerFocus into the
// same native-driven keyboardWillShow/keyboardWillHide calls — instead of
// the independent focusin/focusout DOM events — removes the second pass.
test('under native resize, tapping the composer immediately removes the footer safe-area', () => {
  const t = setup({ nativeResize:true });
  t.listeners.doc.focusin({ target:{ id:'msg-input' } });
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), true, 'the home-indicator gap closes even if the native plugin event is absent');
  t.layout.keyboardWillShow(336);
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), true);
});

test('under native resize, leaving the composer restores the footer safe-area', () => {
  const t = setup({ nativeResize:true });
  t.layout.keyboardWillShow(336);
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), true);
  t.listeners.doc.focusout({ target:{ id:'msg-input' } });
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), false);
  t.layout.keyboardWillHide();
  t.flush();
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), false);
});

test('the iOS wrapper resizes the web view with the keyboard so the peer header stays visible', () => {
  assert.match(iosScene, /keyboardFrameEndUserInfoKey/);
  assert.match(iosScene, /UIView\.animate\(withDuration: duration/);
  assert.match(iosScene, /webView\.frame = target/);
  assert.match(iosScene, /webView\.scrollView\.setContentOffset\(\.zero, animated: false\)/);
});

test('the iOS wrapper restores the full web view with keyboard dismissal', () => {
  assert.match(iosScene, /forName: UIResponder\.keyboardWillHideNotification/);
  assert.match(iosScene, /height: window\.bounds\.height - webView\.frame\.origin\.y/);
});

test('without native resize (Android, browser), the footer still moves immediately on focus — unaffected by the native-event sync', () => {
  const t = setup({ nativeResize:false });
  t.listeners.doc.focusin({ target:{ id:'msg-input' } });
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), true, 'Android has one native resize already — no second pass to coordinate with');
  t.listeners.doc.focusout({ target:{ id:'msg-input' } });
  assert.equal(t.els['s-chat'].classList.contains('composer-focused'), false);
});
