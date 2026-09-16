'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '../client/media-safety.js'), 'utf8');
function runtime({ native = true, reply = 'allowed', bridge = true } = {}) {
  const events = {}, calls = [];
  const context = {
    navigator:{userAgent:native ? 'VaultlixImageSafety/1' : 'Safari'}, crypto:webcrypto, TextEncoder,
    setTimeout, clearTimeout, addEventListener:(name,fn) => events[name] = fn,
    webkit:bridge ? {messageHandlers:{vaultlixCall:{postMessage(message) {
      calls.push(message);
      setTimeout(() => events['vaultlix:image-safety-result']({ detail:{requestId:message.requestId,status:reply} }), 1);
    }}}} : undefined,
    fetch() { throw new Error('Image checks must never use the network'); },
  };
  vm.createContext(context); vm.runInContext(code,context);
  return {api:context.VaultlixMediaSafety,calls};
}
test('native screening stays local and deduplicates identical photos', async () => {
  const {api,calls}=runtime();
  assert.deepEqual(await Promise.all([api.check('YQ=='),api.check('YQ==')]),['allowed','allowed']);
  assert.equal(calls.length,1);
  assert.equal(calls[0].base64,'YQ==');
  assert.equal(await api.check('data:image/png;base64,YQ=='),'allowed');
  assert.equal(calls.length,1);
});
test('blocked, malformed and unavailable outcomes never become allowed',async()=>{
  assert.equal(await runtime({reply:'blocked'}).api.check('Yg=='),'blocked');
  assert.equal(await runtime({reply:'unexpected'}).api.check('Yg=='),'unavailable');
  assert.equal(await runtime({bridge:false}).api.check('Yg=='),'unavailable');
  assert.equal(await runtime().api.check(''),'unavailable');
});
test('unsupported builds do not pretend to have screened photos',async()=>{
  const {api,calls}=runtime({native:false});
  assert.equal(await api.check('YQ=='),'unsupported'); assert.equal(calls.length,0);
});
const html=fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');
function extract(name) {
  const start=html.indexOf('function '+name+'(');
  const end=html.indexOf('\nfunction ',start+1);
  return html.slice(start,end);
}
test('received and cached photo records have no reveal button before local approval',async()=>{
  const context={localImageSafetyEnabled:()=>true,localRecordChecks:new WeakMap(),checkLocalImages:async()=> 'blocked',activeRoomCode:'room',renderChatBody(){},openReportPanel(){},document:{createElement:()=>({children:[],append(...nodes){this.children.push(...nodes);}})}};
  vm.createContext(context);
  vm.runInContext(extract('recordImagesForLocalCheck')+'\n'+extract('renderLocalImageSafetyGate'),context);
  const rec={kind:'file',isImage:true,base64:'YQ==',isMe:false};
  const room={code:'room',messages:[rec]},body={insertBefore(){}},div={children:[],append(...nodes){this.children.push(...nodes);}};
  assert.equal(context.renderLocalImageSafetyGate(room,rec,div,body,{}),true);
  await Promise.resolve();
  div.children=[];
  assert.equal(context.renderLocalImageSafetyGate(room,rec,div,body,{}),true);
  assert.match(div.children[0].children[0].textContent,/possible nudity/);
  assert.equal(div.children[0].children.some(n=>n.textContent==='Show'),false);
  context.localRecordChecks.set(rec,'allowed');
  assert.equal(context.renderLocalImageSafetyGate(room,rec,div,body,{}),false);
});
test('albums and reply thumbnails are independently included in local checks',()=>{
  const context={};vm.createContext(context);vm.runInContext(extract('recordImagesForLocalCheck'),context);
  assert.deepEqual(Array.from(context.recordImagesForLocalCheck({kind:'album',images:[{base64:'a'},{base64:'b'}],replyData:{thumb:'c'}})),['a','b','c']);
});
test('Android bridge returns the same local verdict without using the iOS bridge',async()=>{
  const events={}, calls=[];
  const context={navigator:{userAgent:'VaultlixImageSafety/1'},crypto:webcrypto,TextEncoder,setTimeout,clearTimeout,addEventListener:(name,fn)=>events[name]=fn,VaultlixAndroid:{screenImage(requestId,base64){calls.push(base64);setTimeout(()=>events['vaultlix:image-safety-result']({detail:{requestId,status:'blocked'}}),1);}},fetch(){throw Error('No network permitted');}};
  vm.createContext(context);vm.runInContext(code,context);
  assert.equal(await context.VaultlixMediaSafety.check('YQ=='),'blocked');
  assert.deepEqual(calls,['YQ==']);
});
