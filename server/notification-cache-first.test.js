'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {notificationEnvelope} = require('./notification-envelope');
const client = fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');

test('push staging carries bounded ciphertext, no bearer tokens, and never advances the receive cursor', () => {
  const message = {id:'m1',content:'v2:encrypted',seq:99,from:'bearer-secret',token:'bearer-secret',ts:123};
  const encoded = notificationEnvelope(message);
  const envelope = JSON.parse(encoded);
  assert.equal(envelope.seq,0);
  assert.equal(envelope.from,'peer');
  assert.ok(!encoded.includes('bearer-secret'));
  assert.equal(envelope.content,message.content);
  assert.equal(notificationEnvelope(message,{viewOnce:true}),'');
  assert.equal(notificationEnvelope({...message,content:'plaintext'}),'');
  assert.equal(notificationEnvelope({...message,content:'v2:'+'x'.repeat(1900)}),'');
  assert.equal(notificationEnvelope({...message,content:'v2:'+'😀'.repeat(500)}),'');
  const group = {id:'g1',ciphertext:'g1:encrypted',senderId:'a',createdAt:125,keyVersion:2};
  assert.deepEqual(JSON.parse(notificationEnvelope(group,{group:true})),group);
});

test('expired, malformed and mismatched staged records cannot reappear', () => {
  const source = client.slice(client.indexOf('function stagedNotificationEnvelope('), client.indexOf('async function restoreSecureNativeHistory('));
  const ctx = vm.createContext({Date,JSON,Number}); vm.runInContext(source,ctx);
  const record = {kind:'notification-envelope',id:'m1',receivedAt:1000000,envelope:{id:'m1',content:'v2:cipher',ts:1}};
  assert.equal(ctx.stagedNotificationEnvelope(record,1000001).id,'m1');
  assert.equal(ctx.stagedNotificationEnvelope(record,1600001),null);
  assert.equal(ctx.stagedNotificationEnvelope({...record,receivedAt:undefined},1000001),null);
  assert.equal(ctx.stagedNotificationEnvelope({...record,id:'other'},1000001),null);
  assert.equal(ctx.stagedNotificationEnvelope({...record,envelope:{id:'m1',content:'plaintext'}},1000001),null);
});

function harness() {
  const events = [], resolvers = {};
  const rooms = new Map(['a','b'].map(code=>[code,{code,sharedKey:{},myKeyPair:{},messages:[],everOnline:true}]));
  const context = vm.createContext({
    quickLockActive:false, rooms, privateGroups:new Map(),
    loadRoomSession:() => ({}), isChatConcealed:() => false,
    restoreLocalHistory:room=>new Promise(resolve=>{resolvers[room.code]=()=>{room.messages.push({id:'cached'});resolve();};}),
    restoreSecureNativeHistory:async()=>[],
    setActiveRoom:code=>{assert.equal(rooms.get(code).messages[0].id,'cached');events.push('set:'+code);},
    showScreen:screen=>events.push(screen), hideRestoreSkeleton:()=>events.push('uncover'),
    restoreRoomHistoryInBackground:()=>events.push('background-sync'), flushPendingReads:()=>events.push('read'),
    console, Promise, Map,
  });
  const source = client.slice(client.indexOf('let notificationOpenGeneration = 0;'),client.indexOf('function openPendingNotificationTarget()'));
  vm.runInContext(source,context);
  return {context,events,resolvers};
}

test('notification paints cached messages before revealing the target, with network work afterward', async () => {
  const h = harness(); const job = h.context.openPreparedNotificationTarget('room','a');
  assert.deepEqual(h.events,[]);
  h.resolvers.a(); await job;
  assert.deepEqual(h.events,['set:a','s-chat','read','background-sync','uncover']);
});
test('locking during cache restoration cannot expose the conversation', async () => {
  const h = harness(); const job = h.context.openPreparedNotificationTarget('room','a');
  h.context.quickLockActive=true; h.resolvers.a();
  assert.equal(await job,false); assert.deepEqual(h.events,[]);
});
test('a newer notification target wins even if the older cache read finishes later', async () => {
  const h = harness(); const first = h.context.openPreparedNotificationTarget('room','a');
  const second = h.context.openPreparedNotificationTarget('room','b');
  h.resolvers.b(); await second;
  h.resolvers.a(); assert.equal(await first,false);
  assert.deepEqual(h.events.filter(event=>event.startsWith('set:')),['set:b']);
});

test('duplicate native and startup events share the same preparation instead of flashing the inbox', async () => {
  const h = harness(); const first = h.context.openPreparedNotificationTarget('room','a');
  const second = h.context.openPreparedNotificationTarget('room','a');
  assert.equal(first,second); h.resolvers.a();
  assert.equal(await first,true); assert.equal(await second,true);
  assert.equal(h.events.filter(event=>event==='uncover').length,1);
});
