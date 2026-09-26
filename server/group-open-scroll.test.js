'use strict';

// A group's messages are drawn while its screen is still hidden (display:none),
// where a scroll position cannot be set. Opening it must therefore scroll to the
// newest message once it is showing, or it appears at the very top, on the
// oldest date.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const groups = fs.readFileSync(path.join(__dirname, '..', 'client/groups.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '..', 'client/index.html'), 'utf8');

function extract(name, keyword = 'function') {
  const start = groups.indexOf(`${keyword} ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = groups.indexOf('{', groups.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < groups.length; i++) {
    if (groups[i] === '{') depth++;
    else if (groups[i] === '}' && --depth === 0) return groups.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('the group screen is hidden until it is opened', () => {
  assert.match(client, /\.group-chat\{[^}]*display:none/);
  assert.match(client, /\.group-chat\.open\{display:flex\}/);
});

test('opening a group scrolls to the newest message after the screen is showing', () => {
  const open = extract('openPrivateGroup', 'async function');
  const shown = open.indexOf("classList.add('open')");
  const scrolled = open.indexOf('scrollPrivateGroupToLatest()');
  assert.ok(shown > 0 && scrolled > shown, 'scroll happens after the screen is shown');
});

test('the scroll is repeated a frame later, only while the group is still open', () => {
  const fn = extract('scrollPrivateGroupToLatest');
  assert.match(fn, /body\.scrollTop = body\.scrollHeight;\s*requestAnimationFrame/);
  assert.match(fn, /classList\.contains\('open'\)/);
});
