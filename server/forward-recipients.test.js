'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(__dirname, '../client/groups.js'), 'utf8');
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1);
  let endArgs = source.indexOf('(', start), args = 0;
  for (; endArgs < source.length; endArgs++) {
    if (source[endArgs] === '(') args++;
    if (source[endArgs] === ')' && --args === 0) break;
  }
  const open = source.indexOf('{', endArgs);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(source.lastIndexOf('async ', start) === start - 6 ? start - 6 : start, i + 1);
  }
  throw Error('Unbalanced function');
}
const plain = value => JSON.parse(JSON.stringify(value));
function context(extra = {}) {
  return vm.createContext({ Map, Set, loadAccountState: () => ({ accountId:'me', sessionToken:'session' }),
    rooms:new Map(), privateGroups:new Map(), activeRoomCode:'source', activePrivateGroupId:'source-group',
    roomConcealed: room => !!room.hidden, roomDisplayLabel: room => room.label,
    displayProfileImageUri: value => value || null, ...extra });
}
function install(ctx, source, names) { vm.runInContext(names.map(name => extract(source, name)).join('\n'), ctx); }
const room = (code, extra = {}) => ({ code, label:code, sharedKey:'room-key', everOnline:true, ...extra });
const group = (id, extra = {}) => ({ id, name:id, keys:{ 1:'group-key' }, keyVersion:1,
  members:[{ accountId:'me', active:true }], messages:[], ...extra });

test('recipient list mixes contacts and eligible groups, excludes the source and hidden/unusable chats', () => {
  const ctx = context({ rooms:new Map(['source','same','hidden','no-key','reconnect'].map(id => [id, room(id,
    id === 'hidden' ? { hidden:true } : id === 'no-key' ? { sharedKey:null } : id === 'reconnect' ? { reconnectRequired:true } : {})])),
    privateGroups:new Map([['same',group('same',{ updatedAt:123 })],['source-group',group('source-group')],
      ['rekey',group('rekey',{ requiresRekey:true })],['removed',group('removed',{ members:[] })],['no-key',group('no-key',{ keys:{} })]]) });
  install(ctx, client, ['forwardConversationTargets']);
  const result = ctx.forwardConversationTargets({ sourceGroupId:'source-group' });
  assert.deepEqual(Array.from(result, item => item.id), ['group:same','room:same']);
  assert.equal(ctx.forwardConversationTargets({ includeActiveRoom:true }).some(item => item.id === 'room:source'), true);
});

test('batch retries only failed messages, continues to other recipients, and catches individual send errors', async () => {
  const calls = [], fail = new Set(['room:a:2']);
  const ctx = context({ forwardAttachmentToTarget: async (target, rec) => {
    const id = `${target.id}:${rec.text}`; calls.push(id); if (fail.has(id)) throw Error('network'); return true;
  } });
  install(ctx, client, ['forwardRecordsForTarget','sendForwardBatch']);
  const targets = [{ id:'room:a', kind:'room' },{ id:'group:b', kind:'group' }], recs = [1,2,3].map(n => ({ kind:'text', text:String(n) }));
  const sent = new Map();
  assert.deepEqual(Array.from(await ctx.sendForwardBatch(targets, recs, sent)), ['room:a']);
  assert.deepEqual(calls, ['room:a:1','room:a:2','group:b:1','group:b:2','group:b:3']);
  fail.clear(); await ctx.sendForwardBatch(targets, recs, sent);
  assert.deepEqual(calls.slice(5), ['room:a:2','room:a:3']);
});

test('mixed albums retain thumbnails and retry at the failed group item; direct albums stay together', async () => {
  const calls = []; let fail = true;
  const ctx = context({ forwardAttachmentToTarget: async (_, rec) => { calls.push(rec.fileName); return !(rec.fileName === 'clip.mp4' && fail); } });
  install(ctx, client, ['forwardRecordsForTarget','sendForwardBatch']);
  const rec = { kind:'album', images:[{ fileName:'photo.jpg', mime:'image/jpeg', base64:'abc' },
    { fileName:'clip.mp4', mime:'video/mp4', base64:'video', videoThumb:'thumb' }] };
  assert.equal(ctx.forwardRecordsForTarget({ kind:'room' }, [rec])[0], rec);
  assert.equal(ctx.forwardRecordsForTarget({ kind:'group' }, [rec])[1].videoThumb, 'thumb');
  const progress = new Map(), target = { id:'group:g',kind:'group' };
  await ctx.sendForwardBatch([target], [rec], progress); fail = false;
  await ctx.sendForwardBatch([target], [rec], progress);
  assert.deepEqual(calls, ['photo.jpg','clip.mp4','clip.mp4']);
  const photos = { kind:'album', images:[rec.images[0],rec.images[0]] };
  assert.equal(ctx.forwardRecordsForTarget(target,[photos])[0], photos);
});

test('send rechecks membership and hidden state rather than trusting the stale picker', async () => {
  let calls = 0;
  const ctx = context({ rooms:new Map([['r',room('r')]]), privateGroups:new Map([['g',group('g')]]),
    forwardAttachmentToRoom: async () => { calls++; return true; }, forwardAttachmentToPrivateGroup:async () => { calls++; return true; } });
  install(ctx, client, ['forwardConversationTargets','forwardAttachmentToTarget']);
  const targets = ctx.forwardConversationTargets();
  ctx.rooms.get('r').hidden = true; ctx.privateGroups.get('g').members = [];
  for (const target of targets) assert.equal(await ctx.forwardAttachmentToTarget(target,{ kind:'text',text:'secret' }), false);
  assert.equal(calls, 0);
  assert.equal(await ctx.forwardAttachmentToTarget(targets[0],{ kind:'file',viewOnce:true }), false);
});

test('group forwarding uses the destination key and upload, preserving the active group and composer', async () => {
  const encrypted = [], requests = [], rendered = [];
  const ctx = context({ privateGroups:new Map([['source-group',group('source-group')],['dest',group('dest',{ keys:{ 1:'destination-key' } })]]),
    newMsgId: () => 'new-message', encryptPrivateGroupValue:async (key,payload) => { encrypted.push([key,payload]); return 'ciphertext'; },
    uploadPrivateGroupAttachment:async (_,g) => { assert.equal(g.id,'dest'); return 'attachment'; },
    attachmentCachePut:async () => {}, privateGroupCacheCode:id => `group:${id}`, queuePrivateGroupNativePreview:() => {},
    api:async (route,data) => { requests.push([route,data]); return { createdAt:123, keyVersion:1 }; },
    renderPrivateGroupMessages:g => rendered.push(g.id), renderVaultList:() => {} });
  install(ctx, groups, ['sendPrivateGroupAttachment','forwardAttachmentToPrivateGroup']);
  assert.equal(await ctx.forwardAttachmentToPrivateGroup('dest',{ kind:'file',fileName:'a.pdf',mime:'application/pdf',base64:'abcd',pdfPreview:'thumb',pageCount:2 }), true);
  assert.equal(encrypted[0][0], 'destination-key');
  assert.equal(encrypted[0][1].pdfPreview, 'thumb');
  assert.equal(requests[0][1].groupId, 'dest');
  assert.equal('data' in requests[0][1], false);
  assert.deepEqual(rendered, []);
  assert.equal(ctx.activePrivateGroupId, 'source-group');
  assert.equal(ctx.privateGroups.get('source-group').messages.length, 0);
  assert.equal(await ctx.forwardAttachmentToPrivateGroup('dest',{ kind:'text',text:'hello' }), true);
  assert.equal(encrypted.at(-1)[0], 'destination-key');
  assert.equal(ctx.privateGroups.get('dest').messages.at(-1).text, 'hello');
});

function fakeDocument() {
  class Node {
    constructor() { this.dataset = {}; this.listeners = {}; this.attrs = {}; this.textContent = ''; this.disabled = false; this.hidden = false; }
    setAttribute(k,v) { this.attrs[k] = v; }
    addEventListener(k,v) { this.listeners[k] = v; }
    remove() { this.removed = true; }
    querySelector(s) { return this.nodes?.[s] || null; }
    querySelectorAll() { return this.buttons || []; }
    set innerHTML(html) {
      this.html = html; this.nodes = {}; this.buttons = [];
      for (const key of ['close','share','search','empty','send','selected']) if (html.includes(`data-forward-${key}`)) this.nodes[`[data-forward-${key}]`] = new Node();
      if (this.nodes['[data-forward-send]']) this.nodes['[data-forward-send]'].disabled = true;
      for (const match of html.matchAll(/data-forward-target="([^"]+)" data-forward-name="([^"]+)"/g)) {
        const n = new Node(); n.dataset = { forwardTarget:match[1],forwardName:match[2] }; n.nodes = { '[data-forward-status]':new Node() }; this.buttons.push(n);
      }
    }
  }
  return { createElement:() => new Node(), getElementById:() => null, body:{ appendChild(node) { this.last = node; } } };
}

test('circles select without sending, search retains selection, and explicit Forward sends to all chosen chats once', async () => {
  const doc = fakeDocument(), calls = [], targets = [{ id:'room:a',kind:'room',label:'Alice' },{ id:'group:g',kind:'group',label:'Family' }];
  const ctx = context({ document:doc, forwardConversationTargets:() => targets,
    forwardAttachmentToTarget:async (target,rec) => { calls.push([target.id,rec.kind]); return true; },
    vaultAvatarPalette:() => '', escHtml:value => value, PRIVATE_GROUP_AVATAR_SVG:'<svg/>', SELECTION_ICONS:{ share:'' }, toast:() => {} });
  install(ctx, client, ['forwardRecordsForTarget','sendForwardBatch','showForwardAttachmentPicker']);
  ctx.showForwardAttachmentPicker({ kind:'file',fileName:'photo.jpg' });
  const overlay = doc.body.last, send = overlay.querySelector('[data-forward-send]'), search = overlay.querySelector('[data-forward-search]');
  const [alice,family] = overlay.buttons;
  assert.equal(send.disabled,true);
  alice.onclick(); family.onclick();
  assert.equal(calls.length,0); assert.equal(send.textContent,'Forward (2)');
  search.value = 'family'; search.listeners.input();
  assert.equal(alice.hidden,true); assert.equal(family.hidden,false);
  assert.equal(alice.attrs['aria-checked'],'true');
  await send.onclick();
  assert.deepEqual(calls,[['room:a','file'],['group:g','file']]);
  assert.equal(overlay.removed,true);
});

test('view-once never opens forwarding and a voice note keeps only the external share action', () => {
  const doc = fakeDocument(); let shared = false;
  const ctx = context({ document:doc, toast:() => {}, escHtml:value => value, SELECTION_ICONS:{share:''}, shareMessageRecord:() => { shared = true; } });
  install(ctx, client, ['showForwardAttachmentPicker']);
  ctx.showForwardAttachmentPicker({ kind:'file',viewOnce:true }); assert.equal(doc.body.last,undefined);
  ctx.showForwardAttachmentPicker({ kind:'voice',base64:'abc' });
  assert.equal(doc.body.last.querySelector('[data-forward-send]'),null);
  doc.body.last.querySelector('[data-forward-share]').onclick(); assert.equal(shared,true);
});

test('a failed recipient stays selected for retry while a completed recipient cannot be sent twice', async () => {
  const doc = fakeDocument(), calls = [], targets = [{ id:'room:a',kind:'room',label:'Alice' },{ id:'group:g',kind:'group',label:'Family' }];
  let fail = true;
  const ctx = context({ document:doc, forwardConversationTargets:() => targets,
    forwardAttachmentToTarget:async target => { calls.push(target.id); return target.id !== 'group:g' || !fail; },
    vaultAvatarPalette:() => '', escHtml:value => value, PRIVATE_GROUP_AVATAR_SVG:'<svg/>', SELECTION_ICONS:{ share:'' }, toast:() => {} });
  install(ctx, client, ['forwardRecordsForTarget','sendForwardBatch','showForwardAttachmentPicker']);
  ctx.showForwardAttachmentPicker({ kind:'text',text:'hello' });
  const overlay = doc.body.last, send = overlay.querySelector('[data-forward-send]');
  overlay.buttons.forEach(button => button.onclick()); await send.onclick();
  assert.equal(overlay.removed,undefined);
  assert.equal(send.textContent,'Forward (1)');
  assert.equal(overlay.buttons[0].disabled,true);
  assert.equal(overlay.buttons[1].attrs['aria-checked'],'true');
  fail = false; await send.onclick();
  assert.deepEqual(calls,['room:a','group:g','group:g']);
  assert.equal(overlay.removed,true);
});

test('forwarding a group photo album keeps every photo and its preview', () => {
  const message = { attachment:{ type:'group-album',items:[{ name:'one.jpg',mime:'image/jpeg',data:'a',imagePreview:'thumb' },{ name:'two.jpg',mime:'image/jpeg',data:'b' }] } };
  const ctx = context({ privateGroupMessageById:() => message, groupMessageKind:() => 'album', safeImageDataUri:(_,data) => !!data });
  install(ctx, groups, ['groupMessageToForwardRec']);
  assert.deepEqual(plain(ctx.groupMessageToForwardRec('album')).images.map(item => item.fileName), ['one.jpg','two.jpg']);
  assert.equal(ctx.groupMessageToForwardRec('album').images[0].imagePreview, 'thumb');
  message.attachment.items[0].data = null;
  assert.equal(ctx.groupMessageToForwardRec('album'),null);
});
