'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const client=fs.readFileSync(path.join(root,'client/index.html'),'utf8');
const groups=fs.readFileSync(path.join(root,'client/groups.js'),'utf8');
const fn=(s,n)=>s.match(new RegExp('(?:async )?function '+n+'\\([^]*?\\n}'))[0];
function eraser({native=true,local=true,ios=false,storage=new Map()}={}) {
 const events={},requests=[],warnings=[],ctx={Map,Set,JSON,Promise,crypto:require('node:crypto').webcrypto,console,
 localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},
 toast:m=>warnings.push(m),document:{hidden:false},setInterval:()=>{},setTimeout,clearTimeout,
 historyStoreDelete:async()=>local,
 window:{addEventListener:(n,f)=>events[n]=f}};
 if(ios)ctx.window.webkit={messageHandlers:{vaultlixCall:{postMessage:req=>requests.push(req)}}};
 else ctx.window.VaultlixAndroid={secureDeleteMessage:()=>native};
 vm.createContext(ctx);
 vm.runInContext(client.slice(client.indexOf('const pendingMessageErasures ='),client.indexOf('function redactDeletedReply(')),ctx);
 return {ctx,events,requests,warnings,storage,run:s=>vm.runInContext(s,ctx)};
}
test('failed native or local erasure remains journalled; successful retry clears it',async()=>{
 for(const opts of [{native:false},{local:false}]){
 const e=eraser(opts); e.run("secureNativeDeleteMessage('room','msg')");
 await new Promise(setImmediate);
 assert.equal(e.run('pendingMessageErasures.size'),1);assert.equal(e.warnings.length,1);
 assert.match(e.storage.get('vaultlix_pending_message_erasures_v1'),/msg/);
 e.ctx.historyStoreDelete=async()=>true;e.ctx.window.VaultlixAndroid.secureDeleteMessage=()=>true;
 await e.run('retryPendingMessageErasures()');assert.equal(e.run('pendingMessageErasures.size'),0);
 assert.equal(e.run("cacheRecordErased('room','msg')"),true);
 }
});
test('pending erasure resumes after page restart without plaintext in journal',async()=>{
 const a=eraser({native:false});a.run("secureNativeDeleteMessage('room','msg')");await new Promise(setImmediate);
 const b=eraser({storage:a.storage});await b.run('retryPendingMessageErasures()');assert.equal(b.run('pendingMessageErasures.size'),0);
});
test('iOS requires an acknowledgement with the matching request ID',async()=>{
 const e=eraser({ios:true});e.run("secureNativeDeleteMessage('room','msg')");await new Promise(setImmediate);
 e.events['vaultlix:message-erased']({detail:{requestId:'wrong',success:true}});
 assert.equal(e.run('pendingMessageErasures.size'),1);
 e.events['vaultlix:message-erased']({detail:{requestId:e.requests[0].requestId,success:true}});
 await new Promise(setImmediate);assert.equal(e.run('pendingMessageErasures.size'),0);
});
test('deleting a source redacts dependent reply text and drops its stale cache',()=>{
 const removed=[],quote={textContent:'secret'},ctx={replyTo:null,activeRoomCode:'r',document:{querySelector:()=>({querySelector:()=>quote})},
 cancelSecureNativeCacheWrite:()=>{},secureNativeDeleteMessage:(...a)=>removed.push(a)};
 vm.createContext(ctx);for(const name of ['redactDeletedReply','redactRoomReplies','scrubMessageRecord'])vm.runInContext(fn(client,name),ctx);
 const rec={id:'reply',content:'keep this',replyData:{msgId:'source',text:'secret',thumb:'private'}};
 ctx.redactRoomReplies({code:'r',messages:[rec]},'source');assert.equal(rec.content,'keep this');assert.equal(rec.replyData.text,'Message deleted');assert.equal(rec.replyData.thumb,undefined);assert.equal(quote.textContent,'Message deleted');assert.deepEqual(removed,[['r','reply']]);
 const deleted={replyData:{text:'secret',thumb:'private'}};ctx.scrubMessageRecord(deleted);assert.equal(deleted.replyData.text,'');assert.equal(deleted.replyData.thumb,'');
});
test('group deletion scrubs existing references and dependent replies while preserving unrelated text',()=>{
 const ctx={activePrivateGroupId:null,groupReplyTo:null,secureNativeDeleteMessage:()=>{},privateGroupCacheCode:id=>'group:'+id};vm.createContext(ctx);
 vm.runInContext(fn(client,'redactDeletedReply'),ctx);vm.runInContext(fn(groups,'scrubDeletedGroupMessages'),ctx);
 const deleted={id:'a',text:'secret',ciphertext:'retained cipher',senderId:'alice'},reply={id:'b',text:'keep',reply:{id:'a',text:'secret'},ciphertext:'quote cipher'};
 const group={id:'g',messages:[deleted,reply]};ctx.scrubDeletedGroupMessages(group,['a']);
 assert.equal(deleted.text,undefined);assert.equal(deleted.ciphertext,undefined);assert.equal(group.messages.length,1);assert.equal(reply.text,'keep');assert.equal(reply.reply.text,'Message deleted');assert.equal(reply.ciphertext,undefined);
});
