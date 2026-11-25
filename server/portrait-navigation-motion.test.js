'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');

test('selection visibility adjusts only the horizontal shelf and leaves visible selections alone',()=>{
  const context=vm.createContext({});
  const start=source.indexOf('function keepDailyLookSelectionVisible(');
  vm.runInContext(source.slice(start,source.indexOf('\nfunction createDailyLookSourceTools',start)),context);
  const item={getBoundingClientRect:()=>({left:300,right:436,width:136})};
  const shelf={scrollLeft:100,clientWidth:300,querySelector:()=>item,getBoundingClientRect:()=>({left:20,right:320})};
  context.keepDailyLookSelectionVisible(shelf);
  assert.equal(shelf.scrollLeft,298);
  item.getBoundingClientRect=()=>({left:40,right:176,width:136});
  context.keepDailyLookSelectionVisible(shelf);
  assert.equal(shelf.scrollLeft,298);
  context.keepDailyLookSelectionVisible(null);
});

test('creation animation reuses the selected photo, rotates playful captions and cleans up on stop or restart',()=>{
  let current=null,nextTimer=0; const timers=new Map();
  const card={inert:false};
  const copy={setAttribute(){},classList:{remove(){},add(){}},offsetWidth:200};
  const caption={textContent:'',parentElement:copy};
  const photoSlot={prepend(photo){this.photo=photo;}};
  const overlay={append(layer){current=layer;},querySelector:()=>card};
  const document={
    getElementById:()=>overlay,
    querySelector:selector=>selector.endsWith('.daily-look-card')?card:current,
    createElement(tag){if(tag==='img')return {};return {setAttribute(){},classList:{add(){}},querySelector:selector=>selector==='.daily-look-processing-photo'?photoSlot:selector==='.daily-look-creation-copy'?copy:caption,focus(){},remove(){current=null;}};},
  };
  const context=vm.createContext({document,nativePlatform:()=> 'android',dailyLookSourceImage:'data:image/jpeg;base64,cHJpdmF0ZQ==',window:{setInterval(callback){timers.set(++nextTimer,callback);return nextTimer;},clearInterval(id){timers.delete(id);}}});
  const start=source.indexOf('let dailyLookCreationTimer =');
  vm.runInContext(source.slice(start,source.indexOf('\nfunction resetDailyLookPreviewZoom',start)),context);
  context.startDailyLookCreationAnimation();
  assert.equal(photoSlot.photo.src,'data:image/jpeg;base64,cHJpdmF0ZQ==');
  assert.equal(card.inert,true);
  assert.equal(timers.size,1);
  const messages=new Set();
  for(let i=0;i<20;i++){[...timers.values()][0]();messages.add(caption.textContent);}
  assert.ok(messages.size>=6);
  for(const message of messages)assert.doesNotMatch(message,/almost ready|final mirror|100%/i);
  context.startDailyLookCreationAnimation();
  assert.equal(timers.size,1);
  context.stopDailyLookCreationAnimation();
  assert.equal(timers.size,0);
  assert.equal(current,null);
  assert.equal(card.inert,false);
});
