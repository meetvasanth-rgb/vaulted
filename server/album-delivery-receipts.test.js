'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');
function extract(name){const start=source.indexOf(`function ${name}(`);return source.slice(start,source.indexOf('\n}\n',start)+2);}
function fixture(){
  const classes=new Set(),writes=[];
  const tick={textContent:'✓',classList:{add:x=>classes.add(x),remove:x=>classes.delete(x),toggle(x,on){if(on)classes.add(x);else classes.delete(x);}}};
  const context=vm.createContext({activeRoomCode:'room',document:{getElementById:id=>id==='receipt-first'?tick:null},historyStorePatch:(...args)=>writes.push(args),secureNativeCachedRecords:new WeakSet(),scheduleSecureNativeHistoryCache(){},scheduleReadReceiptCatchup(){},clearReadReceiptCatchup(){},startDeleteTimer(){}});
  for(const name of ['mediaAlbumRecord','handleReadReceipts','pendingDeliveryReceiptIds'])vm.runInContext(extract(name),context);
  const room={code:'room',lastReceiptSeq:99,lastReadReceiptSeq:99,messages:[{id:'first',kind:'file',isMe:true,mime:'image/jpeg',albumGroupId:'album',albumIndex:0,receiptState:null},{id:'second',kind:'file',isMe:true,mime:'image/jpeg',albumGroupId:'album',albumIndex:1,receiptState:null}]};
  return {context,room,tick,classes,writes};
}
test('album stays single-tick until all members deliver, and the last member updates its shared tick without repainting',()=>{
  const {context,room,tick,classes,writes}=fixture();
  context.handleReadReceipts(room,[{msgId:'first',seq:1,deliveredAt:10}]);
  assert.equal(tick.textContent,'✓');
  assert.equal(context.mediaAlbumRecord(room.messages,'album').receiptState,null);
  context.handleReadReceipts(room,[{msgId:'second',seq:2,deliveredAt:20}]);
  assert.equal(tick.textContent,'✓✓');
  assert.equal(classes.has('delivered'),true);
  assert.equal(room.lastReceiptSeq,99,'late acknowledgements never rewind the cursor');
  assert.equal(writes.length,2,'both member acknowledgements persist for reopen');
});
test('album becomes read only after every member is read and stale delivery cannot downgrade it',()=>{
  const {context,room,tick,classes}=fixture();
  context.handleReadReceipts(room,[{msgId:'first',deliveredAt:10,readAt:20},{msgId:'second',deliveredAt:10}]);
  assert.equal(tick.textContent,'✓✓');
  assert.equal(classes.has('read'),false);
  context.handleReadReceipts(room,[{msgId:'second',readAt:30}]);
  assert.equal(classes.has('read'),true);
  context.handleReadReceipts(room,[{msgId:'first',deliveredAt:10}]);
  assert.equal(classes.has('read'),true);
});
test('only submitted, own, unconfirmed messages are probed and probe batches are bounded',()=>{
  const {context,room}=fixture();
  room.messages.push({id:'uploading',isMe:true,pending:true},{id:'peer',isMe:false},{id:'confirmed',isMe:true,receiptState:'delivered'});
  assert.deepEqual(Array.from(context.pendingDeliveryReceiptIds(room)),['first','second']);
  assert.deepEqual(Array.from(context.pendingDeliveryReceiptIds(room,1)),['first']);
  room.messages[0].receiptState='delivered';
  assert.deepEqual(Array.from(context.pendingDeliveryReceiptIds(room)),['second']);
});

test('server receipt repair ids reject malformed input and stay bounded for polls and inbox sync',()=>{
  const server=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
  const start=server.indexOf('function pendingReceiptIdSet(');
  const context=vm.createContext({});
  vm.runInContext(server.slice(start,server.indexOf('\n}\n',start)+2),context);
  const ids=Array.from({length:100},(_,i)=>`message-${i}`);
  assert.equal(context.pendingReceiptIdSet(ids).size,32);
  assert.equal(context.pendingReceiptIdSet(ids,8).size,8);
  assert.equal(context.pendingReceiptIdSet([null,{},'',true,'x'.repeat(97)]).size,0);
  assert.equal(context.pendingReceiptIdSet({}).size,0);
});
