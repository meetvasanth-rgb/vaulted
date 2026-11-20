const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const client=fs.readFileSync(require('node:path').join(__dirname,'../client/index.html'),'utf8');
function harness() {
  const timers=new Map(), frames=[], calls=[]; let id=0;
  const node=(name,top)=>({name,getBoundingClientRect:()=>({top,bottom:top+50,height:50})});
  const nodes=[node('far',1600),node('near3',800),node('visible',200),node('near1',600),node('near2',700)];
  const body={clientHeight:500,getBoundingClientRect:()=>({top:100,bottom:600}),querySelectorAll:()=>nodes,
    addEventListener(){},removeEventListener(){}};
  const context=vm.createContext({WeakMap,WeakSet,Date,attachmentLoadsRunning:0,privateGroupLoadsRunning:0,lastInteractionTime:0,
    document:{hidden:false,addEventListener(){},removeEventListener(){}},
    setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:key=>timers.delete(key),
    requestAnimationFrame:fn=>{frames.push(fn);return 1;},cancelAnimationFrame(){}});
  vm.runInContext(client.slice(client.indexOf('const viewportMediaSchedules ='),client.indexOf('function scheduleAttachmentLoads(')),context);
  context.scheduleViewportMedia(body,{selector:'media',active:()=>true,request:(node,priority)=>calls.push([node.name,priority])});
  return {context,frames,timers,calls,step(){const [key,fn]=timers.entries().next().value||[];if(fn){timers.delete(key);fn();}}};
}
test('visible media starts first; idle preparation is limited to three nearby items',()=>{
  const h=harness(); h.frames.shift()();
  assert.deepEqual(h.calls,[['visible',2]]);
  for(let i=0;i<5;i++)h.step();
  assert.deepEqual(h.calls,[['visible',2],['near1',0],['near2',0],['near3',0]]);
});
test('nearby work waits while visible attachments are loading',()=>{
  const h=harness();h.frames.shift()();h.context.attachmentLoadsRunning=2;h.step();
  assert.equal(h.calls.length,1);
  h.context.attachmentLoadsRunning=0;h.step();assert.deepEqual(h.calls[1],['near1',0]);
});
test('backgrounding the app stops idle preparation',()=>{
  const h=harness();h.frames.shift()();h.context.document.hidden=true;h.step();
  assert.deepEqual(h.calls,[['visible',2]]);
});
