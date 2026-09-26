'use strict';

// Redrawing the chat (a photo finishing its on-device safety check, a history
// restore completing, a retry) rebuilds every message. It must never throw a
// reader who scrolled up down to the newest message. Regression: attachments
// load as they scroll into view, so each photo's post-check redraw fired
// mid-scroll and jumped the list to the bottom.

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

const context = vm.createContext({ CSS:{ escape:value => String(value) } });
for (const name of ['captureChatScrollAnchor', 'restoreChatScrollAnchor']) vm.runInContext(extract(client, name), context);
// Objects made inside the sandbox belong to another realm; round-trip them so deepEqual compares plain values.
const capture = body => { const anchor = context.captureChatScrollAnchor(body); return anchor === null ? null : JSON.parse(JSON.stringify(anchor)); };
const restore = (body, anchor) => context.restoreChatScrollAnchor(body, anchor);

// A tiny stand-in for the chat list: rows stacked from the top of a scrolled body.
function fakeBody(rows, { top = 100, scrollTop = 0, rowHeight = 50 } = {}) {
  const body = { scrollTop, rows };
  const rect = (rowTop, height) => ({ top:rowTop, bottom:rowTop + height });
  body.getBoundingClientRect = () => rect(top, 600);
  body.querySelectorAll = selector => {
    assert.equal(selector, '.msg[data-msg-id]');
    return rows.map((id, index) => ({ dataset:{ msgId:id }, getBoundingClientRect: () => rect(top + index * rowHeight - body.scrollTop, rowHeight) }));
  };
  body.querySelector = selector => {
    const id = /data-msg-id="(.*)"\]/.exec(selector)[1];
    const index = rows.indexOf(id);
    return index < 0 ? null : { getBoundingClientRect: () => rect(top + index * rowHeight - body.scrollTop, rowHeight) };
  };
  return body;
}

test('the anchor is the first message whose bottom is inside the view, with its offset from the top', () => {
  const body = fakeBody(['a', 'b', 'c', 'd', 'e'], { scrollTop:120 }); // a and b are scrolled off; c starts 30px above the top
  assert.deepEqual(capture(body), { id:'c', offset:-20 });
});

test('a message only just scrolled out of view is not the anchor', () => {
  const body = fakeBody(['a', 'b', 'c'], { scrollTop:50 }); // a's bottom is exactly at the top edge
  assert.deepEqual(capture(body), { id:'b', offset:0 });
});

test('an empty chat has no anchor', () => {
  assert.equal(capture(fakeBody([])), null);
});

test('after a redraw that adds height above, the same message goes back to the same place on screen', () => {
  const before = fakeBody(['a', 'b', 'c', 'd', 'e', 'f'], { scrollTop:130 });
  const anchor = capture(before);
  // the redraw: three taller photos now sit above; the anchor message moves down the page
  const after = fakeBody(['p1', 'p2', 'p3', 'a', 'b', 'c', 'd', 'e', 'f'], { scrollTop:130, rowHeight:50 });
  assert.equal(restore(after, anchor), true);
  const row = after.querySelector('.msg[data-msg-id="c"]');
  assert.equal(row.getBoundingClientRect().top - after.getBoundingClientRect().top, anchor.offset);
});

test('after content below changes height the reader still does not move', () => {
  const before = fakeBody(['a', 'b', 'c', 'd'], { scrollTop:40 });
  const anchor = capture(before);
  const after = fakeBody(['a', 'b', 'c', 'd', 'e', 'f'], { scrollTop:40 });
  restore(after, anchor);
  assert.equal(after.scrollTop, 40);
});

test('if the anchor message is gone the redraw reports it could not restore the place', () => {
  const body = fakeBody(['x', 'y']);
  assert.equal(restore(body, { id:'deleted', offset:10 }), false);
});

test('a redraw keeps the reader\'s place unless they are at the bottom or it is a different conversation', () => {
  const render = client.slice(client.indexOf('function renderChatBody('), client.indexOf('function retryChatHistory'));
  assert.match(render, /body\.dataset\.renderedRoom === room\.code/);
  assert.match(render, /body\.scrollHeight - body\.scrollTop - body\.clientHeight > CHAT_NEAR_BOTTOM_PX/);
  assert.match(render, /captureChatScrollAnchor\(body\)/);
  assert.match(render, /body\.dataset\.renderedRoom = room\.code;/);
  assert.match(render, /restoreChatScrollAnchor\(body, readerAnchor\)/);
  // the "scroll to the newest message once the screen has settled" frame must not undo it
  assert.match(render, /if \(!keepPlace && !keptReaderPlace\) requestAnimationFrame/);
  // and an explicit "keep this distance" (load earlier) still takes precedence
  assert.match(render, /keepDistanceFromBottom === null && body\.dataset\.renderedRoom/);
});

test('the photo safety check still redraws the chat when it finishes (which is now safe)', () => {
  const gate = client.slice(client.indexOf('function renderLocalImageSafetyGate('), client.indexOf('function safeProfileImageUri('));
  assert.match(gate, /renderChatBody\(room\);/);
  assert.match(client, /const CHAT_NEAR_BOTTOM_PX = 96;/);
});
