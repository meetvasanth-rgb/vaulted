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
  const mk = (id, extra = {}) => ({ id, style:{}, classList:{ contains:name => !!extra[name] }, ...extra });
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
  const layout = factory({ vv, win, doc, schedule:fn => { const t = { fn, cancelled:false }; queue.push(t); return t; }, cancel:t => { t.cancelled = true; } });
  layout.start();
  const flush = () => { for (const t of queue.splice(0)) if (!t.cancelled) t.fn(); };
  const list = chat === 'direct' ? directList : groupList;
  return { layout, listeners, els, vv, win, list, flush, queue };
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
  assert.match(client, /\)\.start\(\);/);
  assert.doesNotMatch(client, /chat\.style\.height = window\.visualViewport\.height \+ 'px';\s*\n\s*const body = document\.getElementById\('chat-body'\);\s*\n\s*if \(body\) body\.scrollTop = body\.scrollHeight;/);
});
