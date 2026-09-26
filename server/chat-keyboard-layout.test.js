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

function setup({ chat = 'direct', innerHeight = 800 } = {}) {
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
  const layout = factory({ vv, win, doc, schedule:(fn, ms) => { const t = { fn, ms, cancelled:false }; queue.push(t); return t; }, cancel:t => { t.cancelled = true; } });
  layout.start();
  const flush = () => { for (const t of queue.splice(0)) if (!t.cancelled) t.fn(); };
  // Only the pin-after-settling timers (0/120/320/650 ms), not the hold and animation timers.
  const flushSettle = () => { for (const t of queue.filter(item => !item.cancelled && [0, 120, 320, 650].includes(item.ms))) { t.cancelled = true; t.fn(); } };
  const list = chat === 'direct' ? directList : groupList;
  return { layout, listeners, els, vv, win, list, flush, flushSettle, queue };
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
  assert.match(client, /plugin\?\.addListener\?\.\('keyboardWillHide', willHide\)/);
  assert.match(client, /preShrinkOnFocus: \/iP\(hone\|ad\|od\)\/\.test\(navigator\.userAgent\) && !window\.Capacitor\?\.Plugins\?\.Keyboard/);
  const block = client.slice(client.lastIndexOf('<style>'));
  for (const selector of ['#msg-input:focus-visible', '#group-message-input:focus-visible', '#s-chat #msg-input:focus']) assert.ok(block.includes(selector), selector);
  assert.match(block, /outline:none!important;box-shadow:none!important/);
  assert.match(block, /#s-chat #msg-input:focus,#s-chat #msg-input:focus-visible\{background:#FBF8F9!important;border-color:#E3D6DB!important\}/);
  assert.match(block, /\.group-chat\.kb-animating,#s-chat\.kb-animating\{transition:height/);
});
