'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const code = fs.readFileSync(path.join(__dirname, '../client/media-safety.js'), 'utf8');
function runtime({ native = true, reply = 'allowed', bridge = true, storage, source = code } = {}) {
  const events = {}, calls = [];
  const context = {
    localStorage:storage, navigator:{userAgent:native ? 'VaultlixImageSafety/1' : 'Safari'}, crypto:webcrypto, TextEncoder,
    setTimeout, clearTimeout, addEventListener:(name,fn) => events[name] = fn,
    webkit:bridge ? {messageHandlers:{vaultlixCall:{postMessage(message) {
      calls.push(message);
      setTimeout(() => events['vaultlix:image-safety-result']({ detail:{requestId:message.requestId,status:reply} }), 1);
    }}}} : undefined,
    fetch() { throw new Error('Image checks must never use the network'); },
  };
  vm.createContext(context); vm.runInContext(source,context);
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
  const context={setTimeout,clearTimeout,localImageSafetyEnabled:()=>true,localRecordChecks:new WeakMap(),checkLocalImages:async()=> 'blocked',activeRoomCode:'room',renderChatBody(){},openReportPanel(){},document:{createElement:()=>({children:[],append(...nodes){this.children.push(...nodes);}})}};
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

test('missing bridge and unreadable input have different recovery guidance',async()=>{
  const {api}=runtime({bridge:false});
  assert.equal(await api.check('YQ=='),'unavailable');
  assert.match(api.failureMessage(),/Close and reopen/);
  assert.equal(await api.check(''),'unavailable');
  assert.match(api.failureMessage(),/smaller still image/);
});
test('HTML bypasses the unversioned module cached by older service workers',()=>{
  assert.match(html,/src="\/media-safety-v3\.js"/);
  const worker=fs.readFileSync(path.join(__dirname,'../client/sw.js'),'utf8');
  assert.match(worker,/'\/media-safety-v3\.js'/);
  const server=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
  assert.ok(server.includes("url === '/media-safety-v3.js'"));
});

test('approved native photos avoid the second reveal gate, but other attachments stay opt-in',()=>{
  const context={localImageSafetyEnabled:()=>true,localRecordChecks:new WeakMap()};
  vm.createContext(context);vm.runInContext(extract('needsAttachmentReveal'),context);
  for(const rec of [{kind:'file',isImage:true,base64:'photo'}, {kind:'album',images:[{base64:'a'},{base64:'b'}]}, {kind:'file',isImage:true,base64:'photo',viewOnce:true}]) {
    for(const status of [undefined,'pending','blocked','unavailable']) {
      context.localRecordChecks.set(rec,status);
      assert.equal(context.needsAttachmentReveal(rec),true);
    }
    context.localRecordChecks.set(rec,'allowed');
    assert.equal(context.needsAttachmentReveal(rec),false);
    context.localImageSafetyEnabled=()=>false;
    assert.equal(context.needsAttachmentReveal(rec),true);
    context.localImageSafetyEnabled=()=>true;
  }
  for(const rec of [{kind:'file',pdfPreview:'preview'}, {kind:'voice',replyData:{isImage:true,thumb:'photo'}}, {kind:'album',images:[]}]) {
    context.localRecordChecks.set(rec,'allowed');
    assert.equal(context.needsAttachmentReveal(rec),true);
  }
  assert.equal(context.needsAttachmentReveal({kind:'gif'}),false);
});
test('photo checking reports each image and stops at a failed check',async()=>{
  const messages=[],checked=[];
  const context={localImageSafetyEnabled:()=>true,window:{VaultlixMediaSafety:{enabled:true,async check(image){checked.push(image);return image==='bad'?'blocked':'allowed';}}}};
  vm.createContext(context);vm.runInContext('async '+extract('checkLocalImages'),context);
  assert.equal(await context.checkLocalImages(['first','bad','third'],s=>messages.push(s)),'blocked');
  assert.deepEqual(checked,['first','bad']);
  assert.deepEqual(messages,['Checking photo 1 of 3…','Checking photo 2 of 3…']);
});
test('photo send shows feedback before starting and removes it on failure without duplicate sends',async()=>{
  const buttons={},events=[];
  let finish;
  const context={document:{createElement:()=>({style:{},querySelector:key=>buttons[key] ||= {},addEventListener(){},remove(){events.push('overlay-closed');}}),body:{appendChild(){}}},safeImageDataUri:()=>'',MEDIA_BLOCKED_HTML:'',beginPhotoSendProgress:()=>{events.push('progress-visible');return {update(){},close(){events.push('progress-closed');}};},requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),sendAlbumMessage:()=>{events.push('send-started');return new Promise((_,reject)=>{finish=()=>reject(Error('test'));});},toast:()=>events.push('error-shown')};
  vm.createContext(context);vm.runInContext(extract('showSendImageOptions'),context);
  context.showSendImageOptions({},[{file:{type:'image/jpeg'},base64:'a'},{file:{},base64:'b'}]);
  const pending=buttons['#send-img-normal'].onclick();
  await Promise.resolve();
  await buttons['#send-img-normal'].onclick();
  assert.deepEqual(events,['progress-visible','overlay-closed','send-started']);
  finish();await pending;
  assert.deepEqual(events.slice(-2),['error-shown','progress-closed']);
});
test('selection shows progress before compression and waits for every photo before send options',async()=>{
  const events=[];let release;
  const context={getActiveRoom:()=>({}),MAX_FILE_SIZE:1000,beginPhotoSendProgress:()=>{events.push('visible');return{update:s=>events.push(s),close:()=>events.push('closed')};},requestAnimationFrame:fn=>fn(),setTimeout:fn=>fn(),compressImageFile:async file=>{events.push('compress-'+file.name);if(file.name==='a')await new Promise(resolve=>release=resolve);return{base64:'data',mime:'image/jpeg'};},showSendImageOptions:(_,images)=>events.push('options-'+images.length),toast:()=>events.push('error')};
  vm.createContext(context);vm.runInContext('async '+extract('handleFileSelect'),context);
  const pending=context.handleFileSelect({target:{files:[{name:'a',size:10,type:'image/jpeg'},{name:'b',size:10,type:'image/jpeg'}]}});
  await Promise.resolve();
  assert.deepEqual(events,['visible','Encrypting image 1 of 2…','compress-a']);
  release();await pending;
  assert.deepEqual(events.slice(3),['Encrypting image 2 of 2…','compress-b','closed','options-2']);
  events.length=0;context.compressImageFile=async()=>{throw Error('read failed');};
  await context.handleFileSelect({target:{files:[{name:'c',size:10,type:'image/jpeg'}]}});
  assert.deepEqual(events,['visible','Encrypting image 1 of 1…','error','closed']);
});

function approvalStorage() {
  const values = new Map();
  return { values, getItem:key=>values.get(key), setItem:(key,value)=>values.set(key,value), removeItem:key=>values.delete(key) };
}
test('approval fingerprints survive reload without storing photos and changed content is checked', async()=>{
  const storage=approvalStorage();
  await runtime({storage}).api.check('YQ==');
  assert.equal([...storage.values.values()].join('').includes('YQ=='),false);
  const next=runtime({storage});
  assert.equal(await next.api.check('data:image/png;base64,YQ=='),'allowed');
  assert.equal(next.calls.length,0);
  await next.api.check('Yg=='); assert.equal(next.calls.length,1);
  next.api.clear();
  await next.api.check('YQ=='); assert.equal(next.calls.length,2);
});
test('policy changes, expired approvals and storage failures require native checks',async()=>{
  const storage=approvalStorage(); await runtime({storage}).api.check('YQ==');
  const revised=runtime({storage,source:code.replace('nsfw-ios-android-v1','nsfw-ios-android-v2')});
  await revised.api.check('YQ=='); assert.equal(revised.calls.length,1);
  for(const [key,value] of storage.values) storage.setItem(key,JSON.stringify(JSON.parse(value).map(([hash])=>[hash,1])));
  const expired=runtime({storage}); await expired.api.check('YQ=='); assert.equal(expired.calls.length,1);
  const broken=runtime({storage:{getItem(){throw Error();},setItem(){throw Error();}}});
  assert.equal(await broken.api.check('YQ=='),'allowed');assert.equal(broken.calls.length,1);
});
test('view-once bypasses durable approvals and failed checks are never persisted',async()=>{
  const storage=approvalStorage(); await runtime({storage}).api.check('YQ==');
  const ephemeral=runtime({storage});
  await ephemeral.api.check('YQ==',{persist:false});assert.equal(ephemeral.calls.length,1);
  const before=JSON.stringify([...storage.values]);
  await ephemeral.api.check('Yg==',{persist:false});
  assert.equal(JSON.stringify([...storage.values]),before);
  const empty=approvalStorage();
  await runtime({storage:empty,reply:'blocked'}).api.check('YQ==');
  await runtime({storage:empty,reply:'unavailable'}).api.check('YQ==');
  assert.equal(empty.values.size,0);
});
test('quick image checks stay quiet; slow checks show status after delay without revealing media',async()=>{
  let settle, delayed, cleared=false, renders=0, options;
  const context={localImageSafetyEnabled:()=>true,localRecordChecks:new WeakMap(),checkLocalImages:(_images,_progress,value)=>{options=value;return new Promise(resolve=>settle=resolve);},setTimeout:fn=>{delayed=fn;return 1;},clearTimeout:()=>{cleared=true;},activeRoomCode:'room',renderChatBody:()=>renders++,openReportPanel(){},document:{createElement:()=>({children:[],append(...nodes){this.children.push(...nodes);}})}};
  vm.createContext(context);vm.runInContext(extract('recordImagesForLocalCheck')+'\n'+extract('renderLocalImageSafetyGate'),context);
  const rec={kind:'file',isImage:true,base64:'photo',viewOnce:true};
  const room={code:'room',messages:[rec]},body={insertBefore(){}},div={children:[],append(...nodes){this.children.push(...nodes);}};
  assert.equal(context.renderLocalImageSafetyGate(room,rec,div,body,{}),true);
  assert.equal(div.children[0].children[0].textContent,'');
  assert.equal(options.persist,false);
  delayed();assert.equal(renders,1);
  div.children=[];context.renderLocalImageSafetyGate(room,rec,div,body,{});
  assert.match(div.children[0].children[0].textContent,/Checking photo/);
  settle('allowed');await Promise.resolve();assert.equal(cleared,true);
  assert.equal(context.renderLocalImageSafetyGate(room,rec,div,body,{}),false);
});
