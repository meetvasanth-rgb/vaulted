'use strict';

// Bubbles show only a clock time, so a divider names the day whenever it
// changes, in both one-to-one and group chats.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');

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

const sandbox = vm.createContext({
  Date, Number, Math, Intl, String, document:{ documentElement:{ lang:'en' } },
  i18n:key => ({ yesterday:'Yesterday' })[key] || key,
  escHtml:value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'),
});
for (const name of ['dayKey', 'formatDayLabel', 'formatFullDateTime', 'daySeparatorHtml']) vm.runInContext(extract(client, name), sandbox);
const label = (ts, now) => vm.runInContext(`formatDayLabel(${ts}, ${now})`, sandbox);
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime(); // local time on purpose

test('the same local day has the same key; midnight changes it', () => {
  const key = ts => vm.runInContext(`dayKey(${ts})`, sandbox);
  assert.equal(key(at(2026, 9, 25, 0, 1)), key(at(2026, 9, 25, 23, 59)));
  assert.notEqual(key(at(2026, 9, 25, 23, 59)), key(at(2026, 9, 26, 0, 1)));
  assert.notEqual(key(at(2025, 9, 25)), key(at(2026, 9, 25)), 'the same date in another year is another day');
});

test('labels: Today, Yesterday, weekday within a week, then the date', () => {
  const now = at(2026, 9, 26, 15);
  assert.equal(label(at(2026, 9, 26, 0, 5), now), 'Today');
  assert.equal(label(at(2026, 9, 25, 23, 59), now), 'Yesterday');
  assert.equal(label(at(2026, 9, 23), now), 'Wednesday');
  assert.match(label(at(2026, 9, 12), now), /Sat.*12.*Sep|Sat.*Sep.*12/);
  const older = label(at(2025, 12, 31), now);
  assert.match(older, /31/); assert.match(older, /2025/);
});

test('"yesterday" is calendar-based, not 24 hours ago', () => {
  const now = at(2026, 9, 26, 0, 30);
  assert.equal(label(at(2026, 9, 25, 23, 50), now), 'Yesterday'); // 40 minutes earlier
  assert.equal(label(at(2026, 9, 24, 23, 50), now), 'Thursday');
});

test('the full date and time is available for a tooltip, and empty when unknown', () => {
  const full = vm.runInContext(`formatFullDateTime(${at(2026, 9, 12, 18, 9)})`, sandbox);
  assert.match(full, /12/); assert.match(full, /2026/); assert.match(full, /Sep/);
  assert.equal(vm.runInContext('formatFullDateTime(0)', sandbox), '');
});

test('the divider markup is escaped and carries its day', () => {
  const html = vm.runInContext(`daySeparatorHtml(${at(2026, 9, 12)})`, sandbox);
  assert.match(html, /^<div class="day-sep" data-day="2026-9-12"><span>/);
});

test('wiring: one-to-one rows carry their time, dividers refresh after every render, groups add them inline', () => {
  const render = extract(client, 'renderMessageRecord');
  assert.equal((render.match(/div\.dataset\.ts = String\(Number\(rec\.ts\)\)/g) || []).length, 2, 'sys rows and message rows');
  assert.match(extract(client, 'renderChatBody'), /refreshDaySeparators\(body, \{ stick:false \}\);\s*watchChatDaySeparators\(body\);/);
  assert.match(client, /\.day-sep\{display:flex;justify-content:center/);
  assert.match(render, /class="msg-time" title="\$\{escHtml\(formatFullDateTime\(rec\.ts\)\)\}"/);
  assert.match(groups, /class="group-message-time" title="\$\{escHtml\(formatFullDateTime\(message\.createdAt\)\)\}"/);
  assert.match(groups, /const day = dayKey\(message\.createdAt\);/);
});
