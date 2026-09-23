const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const groups = fs.readFileSync(path.join(root, 'client', 'groups.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');

test('an existing encrypted group finishes loading before its screen opens', () => {
  const start = groups.indexOf('async function openPrivateGroup(id)');
  const end = groups.indexOf('\nfunction closePrivateGroup()', start);
  const source = groups.slice(start, end);
  const preload = source.indexOf('await pollPrivateGroup(false, id)');
  const render = source.indexOf('renderPrivateGroupMessages(group)');
  const open = source.indexOf("classList.add('open')");
  assert.ok(preload >= 0, 'group history should be preloaded explicitly');
  assert.ok(render > preload, 'messages must render only after preload');
  assert.ok(open > render, 'the group overlay must open only after messages render');
  assert.match(source, /requestId !== privateGroupOpenRequestId/);
  assert.match(client, /opening \? 'Opening encrypted group…'/);
});

test('status media fills its stage and encrypted video uses a visual loader', () => {
  assert.match(client, /\.status-stage>img,\.status-stage>video\{[^}]*width:100%;height:100%;[^}]*object-fit:cover;border-radius:0/);
  assert.match(client, /status-video-spinner/);
  assert.doesNotMatch(client, /Opening encrypted video…/);
});
