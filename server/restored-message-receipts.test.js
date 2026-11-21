'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname,'../client/index.html'),'utf8');
function extract(name) {
  let start=source.indexOf(`function ${name}(`);
  if(source.slice(start-6,start)==='async ') start-=6;
  return source.slice(start,source.indexOf('\n}\n',start)+2);
}
function fixture() {
  const paints=[], timers=[], cached=[];
  const context=vm.createContext({activeRoomCode:null, ENCRYPTED_ATTACHMENT_PREFIX:'attachment:',
    processIncomingContent:async (_room,_content,_name,_time,id,ts,_from,deleteTimerSeconds,readAt)=>({id,ts,kind:'text',isMe:false,receiptState:null,deleteTimerSeconds,readAt}),
    formatMsgTime:()=>'', applyReactionSnapshot(){}, applyPendingDirectMessageEdit(){},
    isRoomVisible:()=>true, renderChatBody:room=>paints.push(room.messages.map(row=>row.receiptState)),
    historyStorePatch(){}, scheduleReadReceiptCatchup(){}, clearReadReceiptCatchup(){},
    secureNativeCachedRecords:new WeakSet(),
    scheduleSecureNativeHistoryCache:(_room,records)=>cached.push(...records),
    startDeleteTimer:(room,id,seconds)=>{
      const rec=room.messages.find(row=>row.id===id);
      rec.timerStarted=true; timers.push({id,deadline:rec.readAt+seconds*1000});
    },
    setTimeout:()=>1,
  });
  for(const name of ['handleReadReceipts','restoreOwnTicks','applyRestoredHistory']) vm.runInContext(extract(name),context);
  const room={code:'r',token:'me',messages:[],seenMsgIds:new Set(),deleteLedger:new Map(),msgTimers:new Map(),
    readConfirmIds:[],lastSeq:99,lastReceiptSeq:99,lastReadReceiptSeq:99};
  return {context,room,paints,timers,cached};
}
const envelope=(id,extra={})=>({id,type:'message',from:'me',seq:2,ts:100,content:'ciphertext',deleteTimerSeconds:0,...extra});

test('delivered envelopes restore double ticks before first paint even when receipt cursor is ahead',async()=>{
  const {context,room,paints,cached}=fixture();
  await context.applyRestoredHistory(room,[envelope('sent',{deliveredAt:120})],150);
  assert.equal(room.messages[0].receiptState,'delivered');
  assert.equal(room.messages[0].deliveredAt,120);
  assert.equal(paints[0][0],'delivered');
  assert.equal(room.lastReceiptSeq,99);
  assert.equal(cached.length,1,'persist the confirmed ticks for an offline reopen');
});

test('read envelopes restore burgundy ticks and retain the original expiry deadline',async()=>{
  const {context,room,timers}=fixture();
  await context.applyRestoredHistory(room,[envelope('read',{deliveredAt:110,readAt:120,deleteTimerSeconds:1800})],150);
  assert.equal(room.messages[0].receiptState,'read');
  assert.equal(room.messages[0].deleteTimerSeconds,1800);
  assert.deepEqual(timers,[{id:'read',deadline:1800120}]);
});

test('already-seen native records and attachment placeholders receive envelope receipts too',async()=>{
  const {context,room}=fixture();
  room.messages.push({id:'native',isMe:true,kind:'text',receiptState:null});
  room.seenMsgIds.add('native');
  await context.applyRestoredHistory(room,[envelope('native',{readAt:130}),envelope('file',{content:'attachment:ref',deliveredAt:120})],150);
  assert.equal(room.messages.find(row=>row.id==='native').receiptState,'read');
  assert.equal(room.messages.find(row=>row.id==='file').receiptState,'delivered');
});

test('stale delivery-only envelopes cannot downgrade read ticks; unsent acknowledgements are not invented',async()=>{
  const {context,room}=fixture();
  room.messages.push({id:'read',isMe:true,receiptState:'read',readAt:130});
  room.seenMsgIds.add('read');
  await context.applyRestoredHistory(room,[envelope('read',{deliveredAt:120}),envelope('sent-only')],150);
  assert.equal(room.messages.find(row=>row.id==='read').receiptState,'read');
  assert.equal(room.messages.find(row=>row.id==='sent-only').receiptState,null);
});
