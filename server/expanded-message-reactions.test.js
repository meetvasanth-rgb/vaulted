'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const client=fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');
const groups=fs.readFileSync(path.join(__dirname,'../client/groups.js'),'utf8');
const pickerSource=client.slice(client.indexOf('let expandedMessageReactionPicker ='),client.indexOf('function selectionIconSvg('));
function element() {
  return {style:{},listeners:{},attributes:{},hidden:false,
    setAttribute(key,value){this.attributes[key]=value;},
    addEventListener(key,fn){this.listeners[key]=fn;},
    removeEventListener(key){delete this.listeners[key];},
    querySelectorAll(){return [];},remove(){this.removed=true;}};
}
function fixture() {
  const anchor={isConnected:true};
  let state={count:1,anchor,currentReaction:'❤️'};
  const reactions=[], overlay=element(),tabs=element(),grid=element(),button=element(),react=element();
  overlay.querySelector=selector=>selector.includes('tabs')?tabs:grid;
  react.querySelector=()=>button;
  const document={...element(),createElement:()=>overlay,body:{appendChild(){}},activeElement:null};
  const controller={state:()=>state,react:emoji=>reactions.push(emoji)};
  const context=vm.createContext({document,window:{visualViewport:null},innerHeight:800,
    messageSelectionController:controller,messageSelectionUi:{react},positionMessageReactionBar(){}});
  vm.runInContext(pickerSource,context);
  return {context,overlay,tabs,grid,reactions,controller,setState:value=>{state=value;}};
}
function choose(overlay,emoji) {
  overlay.listeners.click({target:{closest:selector=>selector==='[data-emoji]'?{dataset:{emoji}}:null}});
}
test('expanded catalogue is compatible with existing direct-reaction transport and quick reactions',()=>{
  const {context}=fixture();
  const emojis=vm.runInContext('[...MESSAGE_REACTION_EMOJIS]',context);
  assert.ok(emojis.length>400);
  for(const emoji of emojis) assert.ok(emoji.length<=8,`${emoji} would be truncated by the server`);
  for(const emoji of ['👍','❤️','😂','😮','😢','🙏','💯','🫶','👍🏿']) assert.equal(context.isSupportedMessageReaction(emoji),true);
  for(const value of ['<img>','hello','😀😀',null]) assert.equal(context.isSupportedMessageReaction(value),false);
});
test('choosing an expanded reaction delegates once to the selected direct or group controller',()=>{
  const {context,overlay,reactions,grid}=fixture();
  context.openExpandedMessageReactions();
  assert.match(grid.innerHTML,/data-emoji="🤩"/);
  choose(overlay,'🤩');
  assert.deepEqual(reactions,['🤩']);
  assert.equal(overlay.removed,true);
  assert.equal(vm.runInContext('expandedMessageReactionPicker',context),null);
});
test('changing the selected message while the picker is open never reacts to the wrong message',()=>{
  const {context,overlay,reactions,setState}=fixture();
  context.openExpandedMessageReactions();
  setState({count:1,anchor:{isConnected:true}});
  choose(overlay,'🤩');
  assert.deepEqual(reactions,[]);
});
test('closing the expanded picker keeps selection and sends nothing',()=>{
  const {context,overlay,reactions,controller}=fixture();
  context.openExpandedMessageReactions();
  context.closeExpandedMessageReactions();
  assert.equal(context.messageSelectionController,controller);
  assert.equal(overlay.removed,true);
  assert.deepEqual(reactions,[]);
});
test('group sending and decrypted controls both accept the expanded catalogue',()=>{
  assert.match(groups,/!group \|\| !state \|\| !isSupportedMessageReaction\(emoji\)/);
  assert.match(groups,/const emoji = isSupportedMessageReaction\(metadata\.emoji\) \? metadata\.emoji : ''/);
  assert.match(client,/data-more-reactions aria-label="More emojis" aria-haspopup="dialog"/);
});
