'use strict';

// Group photos, videos and files are placeholders until they scroll near the
// screen, then load from this device (or the network) one by one, in place.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');

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

function load({ decode } = {}) {
  const log = { decoded:[], replaced:[], queued:[] };
  const sandbox = vm.createContext({
    Map, Set, String, Array, JSON, Promise, Object, Number, Math, Infinity, Error,
    ATTACHMENT_LOAD_CONCURRENCY:2, ATTACHMENT_AUTO_RETRIES:3,
    ATTACHMENT_TRANSIENT_REASONS:new Set(['offline', 'network', 'timeout', 'busy', 'failed']),
    activePrivateGroupId:'g1', privateGroups:new Map(),
    loadAccountState:() => ({ accountId:'me' }),
    attachmentFailureReason:error => (error.status === 404 ? 'gone' : (error.status ? 'busy' : 'network')),
    document:{ querySelector:() => null },
    CSS:{ escape:value => value },
    window:{ addEventListener() {} },
    replacePrivateGroupRow:(group, message) => log.replaced.push(message.id + ':' + (message.attachmentState || 'loaded')),
    decodePrivateGroupAttachment:async (group, state, message, attachmentId, options) => {
      log.decoded.push([message.id, attachmentId, Object.keys(message).sort().join(',')]);
      if (decode) return decode(message);
      return { ...message, attachmentId, attachment:{ type:'group-image', data:'QUJD' } };
    },
  });
  sandbox.document.addEventListener = () => {};
  vm.runInContext('const privateGroupLoadQueue = []; const privateGroupLoadKeys = new Set(); let privateGroupLoadsRunning = 0; let privateGroupLoadObserver = null;', sandbox);
  for (const name of ['queuePrivateGroupAttachmentLoad', 'pumpPrivateGroupAttachmentLoads', 'retryTransientPrivateGroupAttachments']) vm.runInContext(extract(name), sandbox);
  vm.runInContext(extract('loadPrivateGroupAttachment', 'async function'), sandbox);
  return { sandbox, log };
}
const plain = value => JSON.parse(JSON.stringify(value));
const placeholder = (id, extra = {}) => ({ id, senderId:'a', createdAt:1, keyVersion:1, attachmentId:`att-${id}`, attachmentState:'loading', ...extra });
const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test('a placeholder becomes the real attachment in place', async () => {
  const { sandbox, log } = load();
  const group = { id:'g1', messages:[placeholder('m1'), placeholder('m2')] };
  sandbox.privateGroups.set('g1', group);
  const result = plain(await vm.runInContext("loadPrivateGroupAttachment('g1', 'm1')", sandbox));
  assert.equal(result.attachment.type, 'group-image');
  assert.ok(!result.attachmentState);
  assert.equal(group.messages[0].attachment.type, 'group-image');
  assert.equal(group.messages[1].attachmentState, 'loading', 'others are untouched');
  assert.deepEqual(log.replaced, ['m1:loaded']);
  assert.ok(!log.decoded[0][2].includes('attachmentState'), 'loader state is not passed into the decoder');
  assert.ok(!log.decoded[0][2].includes('attachmentLoading'));
});

test('a failed download leaves a tappable message with the reason, and counts retries', async () => {
  const { sandbox, log } = load({ decode:() => { throw Object.assign(new Error('x'), { status:404 }); } });
  const group = { id:'g1', messages:[placeholder('m1', { autoRetries:1 })] };
  sandbox.privateGroups.set('g1', group);
  await vm.runInContext("loadPrivateGroupAttachment('g1', 'm1')", sandbox);
  const message = plain(group.messages[0]);
  assert.equal(message.attachmentState, 'unavailable');
  assert.equal(message.unavailableReason, 'gone');
  assert.equal(message.autoRetries, 1);
  assert.deepEqual(log.replaced, ['m1:unavailable']);
  assert.ok(!('attachmentLoading' in message) || message.attachmentLoading === false);
});

test('an unreadable attachment is not retried automatically', async () => {
  const { sandbox } = load({ decode:() => { throw Object.assign(new Error('bad'), { corrupt:true }); } });
  const group = { id:'g1', messages:[placeholder('m1')] };
  sandbox.privateGroups.set('g1', group);
  await vm.runInContext("loadPrivateGroupAttachment('g1', 'm1')", sandbox);
  assert.equal(group.messages[0].unavailableReason, 'failed');
  assert.ok(group.messages[0].autoRetries >= 3);
  vm.runInContext("retryTransientPrivateGroupAttachments(privateGroups.get('g1'))", sandbox);
  assert.equal(group.messages[0].attachmentState, 'unavailable');
});

test('a message deleted while it loads is not brought back', async () => {
  let release;
  const { sandbox, log } = load({ decode:message => new Promise(resolve => { release = () => resolve({ ...message, attachment:{ type:'group-image', data:'QQ==' } }); }) });
  const group = { id:'g1', messages:[placeholder('m1')] };
  sandbox.privateGroups.set('g1', group);
  const job = vm.runInContext("loadPrivateGroupAttachment('g1', 'm1')", sandbox);
  await tick();
  group.messages.length = 0;
  release();
  assert.equal(await job, null);
  assert.deepEqual(log.replaced, []);
});

test('one message is never loaded twice at once', async () => {
  let release, calls = 0;
  const { sandbox } = load({ decode:message => { calls++; return new Promise(resolve => { release = () => resolve({ ...message, attachment:{ type:'group-image', data:'QQ==' } }); }); } });
  const group = { id:'g1', messages:[placeholder('m1')] };
  sandbox.privateGroups.set('g1', group);
  const first = vm.runInContext("loadPrivateGroupAttachment('g1', 'm1')", sandbox);
  await tick();
  assert.equal(await vm.runInContext("loadPrivateGroupAttachment('g1', 'm1')", sandbox), null);
  release(); await first;
  assert.equal(calls, 1);
});

test('the queue runs two at a time, newest waiting first, and never queues a message twice', async () => {
  const order = []; const releases = [];
  const { sandbox } = load({ decode:message => new Promise(resolve => { order.push(message.id); releases.push(() => resolve({ ...message, attachment:{ type:'group-image', data:'QQ==' } })); }) });
  const group = { id:'g1', messages:['m1', 'm2', 'm3', 'm4', 'm5'].map(id => placeholder(id)) };
  sandbox.privateGroups.set('g1', group);
  for (const id of ['m1', 'm2', 'm3', 'm4', 'm5', 'm5', 'm1']) vm.runInContext(`queuePrivateGroupAttachmentLoad('g1', '${id}')`, sandbox);
  await tick();
  assert.deepEqual(order, ['m1', 'm2'], 'only two run at once');
  releases[0](); await tick();
  assert.deepEqual(order, ['m1', 'm2', 'm5'], 'of those waiting, the newest goes first');
  releases[1](); await tick();
  assert.deepEqual(order, ['m1', 'm2', 'm5', 'm4']);
  for (let i = 2; i < 5; i++) { releases[i]?.(); await tick(); }
  assert.deepEqual([...order].sort(), ['m1', 'm2', 'm3', 'm4', 'm5'], 'each message loaded exactly once');
});

test('coming back online retries transient failures up to three times, then stops', () => {
  const { sandbox } = load();
  const group = { id:'g1', messages:[
    placeholder('a', { attachmentState:'unavailable', unavailableReason:'offline', autoRetries:0 }),
    placeholder('b', { attachmentState:'unavailable', unavailableReason:'gone', autoRetries:0 }),
    placeholder('c', { attachmentState:'unavailable', unavailableReason:'busy', autoRetries:3 }),
  ] };
  sandbox.privateGroups.set('g1', group);
  vm.runInContext("retryTransientPrivateGroupAttachments(privateGroups.get('g1'))", sandbox);
  const states = Object.fromEntries(plain(group.messages).map(message => [message.id, [message.attachmentState, message.autoRetries]]));
  assert.deepEqual(states.a, ['loading', 1]);
  assert.deepEqual(states.b, ['unavailable', 0], 'a gone attachment is not retried');
  assert.deepEqual(states.c, ['unavailable', 3], 'retries are limited');
});

test('wiring: the render makes placeholders, wires retry, and schedules loads as they come into view', () => {
  assert.match(groups, /message\.attachmentState === 'loading'\) \{\s*content = ATTACHMENT_LOADING_HTML; usable = false;/);
  assert.match(groups, /content = attachmentUnavailableHtml\(\{ unavailableReason:message\.unavailableReason \}\); usable = false;/);
  assert.match(extract('renderPrivateGroupMessages'), /wirePrivateGroupAttachmentRetry\(row, group\)/);
  assert.match(extract('renderPrivateGroupMessages'), /schedulePrivateGroupAttachmentLoads\(body, group\);\s*\}$/);
  assert.match(extract('schedulePrivateGroupAttachmentLoads'), /rootMargin:'400px 0px'/);
  assert.match(extract('openPrivateGroup', 'async function'), /retryTransientPrivateGroupAttachments\(group\)/);
  assert.match(extract('groupMessagePreview'), /case 'attachment': return 'Attachment'/);
  // Nothing downloads while decoding a batch of messages.
  assert.doesNotMatch(extract('decodePrivateGroupBatch', 'async function'), /decodePrivateGroupAttachment\(/);
});
