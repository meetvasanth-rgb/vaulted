'use strict';

// Long-pressing (or tapping the text of) a group message opens the same action
// row as a direct conversation: Reply, React, Copy/Save, Forward, Select, Delete.
// Reactions and deletes are control messages in the encrypted stream, so the
// rules for who may delete what and how they are applied are tested here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const groups = read('client/groups.js');
const client = read('client/index.html');

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

const sandbox = vm.createContext({ Map, Set, String, Array, JSON });
vm.runInContext("const GROUP_REACTIONS = ['👍','❤️','😂','😮','😢','🙏'];", sandbox);
for (const name of ['sanitizeGroupReply', 'groupMessageKind', 'groupMessagePreview', 'privateGroupDeletedIds', 'derivePrivateGroupView', 'groupReactionChipsHtml']) {
  vm.runInContext(extract(groups, name), sandbox);
}
// Results are plain data; round-trip them so assertions compare values, not realms.
// `undefined` has no JSON form, so it comes back as null.
const run = expression => JSON.parse(vm.runInContext(`JSON.stringify(${expression}) ?? 'null'`, sandbox));

const T = (id, senderId, extra = {}) => ({ id, senderId, text:`text ${id}`, createdAt:1, ...extra });
const view = (messages, hidden = []) => run(`(() => {
  const v = derivePrivateGroupView(${JSON.stringify(messages)}, ${JSON.stringify(hidden)});
  return { visible: v.visible.map(m => m.id), reactions: [...v.reactions].map(([id, map]) => [id, [...map]]) };
})()`);

test('control messages are never shown as bubbles', () => {
  const result = view([T('m1', 'a'), { id:'c1', senderId:'b', control:{ type:'reaction', target:'m1', emoji:'👍' } }]);
  assert.deepEqual(result.visible, ['m1']);
});

test('the sender can delete their own message for everyone', () => {
  const result = view([T('m1', 'a'), T('m2', 'b'), { id:'d1', senderId:'a', control:{ type:'delete', target:'m1' } }]);
  assert.deepEqual(result.visible, ['m2']);
});

test('nobody can delete somebody else\'s message', () => {
  const result = view([T('m1', 'a'), { id:'d1', senderId:'b', control:{ type:'delete', target:'m1' } }]);
  assert.deepEqual(result.visible, ['m1']);
});

test('"delete for me" hides a message on this device only', () => {
  assert.deepEqual(view([T('m1', 'a'), T('m2', 'b')], ['m2']).visible, ['m1']);
});

test('one reaction per person per message, the latest wins, and an empty one clears it', () => {
  const stream = [
    T('m1', 'a'),
    { id:'r1', senderId:'b', control:{ type:'reaction', target:'m1', emoji:'👍' } },
    { id:'r2', senderId:'c', control:{ type:'reaction', target:'m1', emoji:'❤️' } },
    { id:'r3', senderId:'b', control:{ type:'reaction', target:'m1', emoji:'😂' } },
    { id:'r4', senderId:'c', control:{ type:'reaction', target:'m1', emoji:'' } },
  ];
  assert.deepEqual(view(stream).reactions, [['m1', [['b', '😂']]]]);
});

test('a reaction to a message that is not there, or to another control message, is ignored', () => {
  const stream = [
    T('m1', 'a'),
    { id:'r1', senderId:'b', control:{ type:'reaction', target:'ghost', emoji:'👍' } },
    { id:'r2', senderId:'b', control:{ type:'reaction', target:'r1', emoji:'👍' } },
  ];
  assert.deepEqual(view(stream).reactions, []);
});

test('reaction chips count repeats and mark your own', () => {
  const html = vm.runInContext(`groupReactionChipsHtml(new Map([['a','👍'],['b','👍'],['me','❤️']]), 'me')`, sandbox);
  assert.match(html, /👍<small>2<\/small>/);
  assert.match(html, /msg-reaction-badge mine">❤️<\/span>/);
  assert.equal(vm.runInContext('groupReactionChipsHtml(new Map(), "me")', sandbox), '');
});

test('a reply quote from another member is trimmed and validated', () => {
  const long = 'x'.repeat(500);
  const ok = run(`sanitizeGroupReply({ id:'m1', kind:'image', name:${JSON.stringify(long)}, text:${JSON.stringify(long)} })`);
  assert.equal(ok.name.length, 60);
  assert.equal(ok.text.length, 160);
  assert.equal(ok.kind, 'image');
  assert.equal(run("sanitizeGroupReply({ id:'m1', kind:'<script>' })").kind, 'text');
  assert.equal(run('sanitizeGroupReply(null)'), null);
  assert.equal(run("sanitizeGroupReply({ text:'no id' })"), null);
  assert.equal(run(`sanitizeGroupReply({ id:${JSON.stringify('i'.repeat(97))} })`), null);
});

test('message kind and reply preview describe every message type', () => {
  const kind = message => vm.runInContext(`groupMessageKind(${JSON.stringify(message)})`, sandbox);
  assert.equal(kind({ attachment:{ type:'group-image' } }), 'image');
  assert.equal(kind({ attachment:{ type:'group-voice' } }), 'voice');
  assert.equal(kind({ attachment:{ type:'group-file' } }), 'file');
  assert.equal(kind({ gif:{ type:'group-gif' } }), 'gif');
  assert.equal(kind({ text:'hi' }), 'text');
  const preview = message => vm.runInContext(`groupMessagePreview(${JSON.stringify(message)})`, sandbox);
  assert.equal(preview({ attachment:{ type:'group-image' } }), 'Photo');
  assert.equal(preview({ attachment:{ type:'group-file', name:'Doc.pdf' } }), 'Doc.pdf');
  assert.equal(preview({ text:'y'.repeat(300) }).length, 160);
});

test('every message gets the direct-chat action row; unreadable ones only Select and Delete', () => {
  assert.match(groups, /msgActionBtn\('reply', 'Reply'\), msgActionBtn\('react', 'React'\)/);
  assert.match(groups, /kind === 'text' \? msgActionBtn\('copy', 'Copy'\) : \(\['image', 'file', 'voice'\]\.includes\(kind\) \? msgActionBtn\('save', 'Save'\)/);
  assert.match(groups, /\['text', 'image', 'file'\]\.includes\(kind\) \? msgActionBtn\('forward', 'Forward'\)/);
  assert.match(groups, /: \[msgActionBtn\('select', 'Select'\), msgActionBtn\('delete', 'Delete'\)\]/);
  assert.match(groups, /attachLongPress\(row\.querySelector\('\.group-message'\), id, \(\) => \{ if \(groupSelectMode\)/);
});

test('long-press supports a custom handler and the outside-tap closer leaves group messages alone', () => {
  assert.match(client, /function attachLongPress\(el, msgId, onFire\)/);
  assert.match(client, /if \(onFire\) onFire\(msgId\);/);
  assert.match(client, /!e\.target\.closest\('\.group-msg'\)/);
});

test('a reply travels as a wrapper, a plain message stays plain text', () => {
  assert.match(groups, /reply \? \{ type:'group-text', text, reply \} : text/);
  assert.match(groups, /metadata\?\.type === 'group-text' && typeof metadata\.text === 'string'/);
  assert.match(groups, /cancelPrivateGroupReply\(\);\s*\n\s*group\.messages = /);
});

test('reactions and deletes are sent as control messages and deletes for everyone are sender-only in the UI', () => {
  assert.match(groups, /type:'group-reaction', target:messageId, emoji:next/);
  assert.match(groups, /type:'group-delete', target:id/);
  assert.match(groups, /const allMine = ids\.every\(id => privateGroupMessageById\(id\)\?\.senderId === state\.accountId\)/);
  assert.match(groups, /\$\{allMine \? '<button type="button" class="everyone"/);
});

test('"delete for me" is remembered with the saved group, without ever dropping what was stored', () => {
  assert.match(client, /hiddenIds:Array\.isArray\(group\.hiddenIds\) \? group\.hiddenIds\.slice\(-PRIVATE_GROUP_HIDDEN_MAX\) : \(stored\.get\(group\.id\)\?\.hiddenIds \|\| \[\]\)/);
});

test('leaving the group or reopening it clears any half-finished reply or selection', () => {
  assert.match(groups, /cancelPrivateGroupReply\(\); exitPrivateGroupSelectMode\(\);\s*\n\s*activePrivateGroupId = null;/);
});

test('a voice note can be saved but never forwarded', () => {
  assert.match(groups, /\['group-image', 'group-file', 'group-voice'\]\.includes\(attachment\.type\)/);
  assert.match(groups, /found\.attachment\.type === 'group-voice'\) return;/);
});

test('the action row and reaction strip sit under the bubble, not inside it', () => {
  assert.match(groups, /<div class="group-message\$\{mine \? ' mine' : ''\}[^"]*">[\s\S]*<div class="group-message-time"[^>]*>[^`]*<\/div><\/div>\$\{actions\}<\/div>`;/);
  assert.match(client, /\.group-msg \.msg-actions\{width:max-content/);
});

test('member Remove and Report/Block are compact icon buttons with labels', () => {
  assert.match(groups, /class="icon-btn" onclick="removePrivateGroupMember\([^"]*\)" aria-label="Remove from group" title="Remove from group"/);
  assert.match(groups, /class="icon-btn report" onclick="reportPrivateGroupMember\([^"]*\)" aria-label="Report or block" title="Report or block"/);
  assert.doesNotMatch(groups, />Remove<\/button>/);
  assert.doesNotMatch(groups, />Report \/ block<\/button>/);
});

test('your own attachments sit in a white bubble with burgundy text', () => {
  assert.match(groups, /\$\{message\.attachment \|\| message\.gif \|\| message\.attachmentState \? ' has-attachment' : ''\}/);
  assert.match(client, /\.group-message\.mine\.has-attachment\{background:#fff;color:#682c43\}/);
  assert.match(client, /\.group-message\.mine\.has-attachment \.group-message-time\{color:#682c43/);
  // Text-only messages of your own keep the burgundy bubble.
  assert.match(client, /\.group-message\.mine\{align-self:flex-end;background:#682c43;color:#fff\}/);
});
