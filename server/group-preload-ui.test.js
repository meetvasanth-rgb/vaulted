const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const groups = fs.readFileSync(path.join(root, 'client', 'groups.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');

test('saved encrypted groups preload in the inbox and their screen opens immediately', () => {
  const start = groups.indexOf('async function openPrivateGroup(id)');
  const end = groups.indexOf('\nfunction closePrivateGroup()', start);
  const source = groups.slice(start, end);
  const preload = source.indexOf('await preloadPrivateGroup(id, { priority:true })');
  const render = source.indexOf('renderPrivateGroupMessages(group)');
  const open = source.indexOf("classList.add('open')");
  assert.ok(open > render, 'the group shell should render before it opens');
  assert.ok(preload > open, 'an unfinished preload must continue after the group screen opens');
  assert.match(source, /requestId !== privateGroupOpenRequestId/);
  assert.match(groups, /PRIVATE_GROUP_PRELOAD_CONCURRENCY = 3/);
  assert.match(groups, /function preloadPrivateGroupsInBackground\(\)/);
  assert.match(client, /historyHydrated:false[\s\S]*preloadPrivateGroupsInBackground\(\)/);
  assert.match(groups, /Loading encrypted messages…/);
  assert.match(groups, /group\.historyHydrated = true/);
});

test('status media fills its stage and encrypted video uses a visual loader', () => {
  assert.match(client, /\.status-stage>img,\.status-stage>video\{[^}]*width:100%;height:100%;[^}]*object-fit:contain;border-radius:0/);
  assert.match(client, /status-video-spinner/);
  assert.doesNotMatch(client, /Opening encrypted video…/);
});
