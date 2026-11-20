const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../client/index.html'),'utf8');
function load(fetch) {
  const ctx=vm.createContext({fetch,document:{hidden:false},Date,lastInteractionTime:0,
    attachmentLoadsRunning:0,privateGroupLoadsRunning:0,AbortController,TextDecoder,
    setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(source.slice(source.indexOf('let recentMediaWarmupsStarted ='),source.indexOf('const mediaPreviewBackfillKeys =')),ctx);
  return ctx;
}
test('large background attachments are rejected before their body is read',async()=>{
  let cancelled=false;
  const ctx=load(async()=>({ok:true,headers:{get:()=>String(20*1024*1024)},body:{cancel:async()=>{cancelled=true;},getReader:()=>{throw Error('Must not read');}}}));
  assert.equal(await ctx.downloadRecentMediaWhileIdle('/api/attachment/content',{}),null);
  assert.equal(cancelled,true);
});
test('warmup request budget is capped at six per launch',async()=>{
  let requests=0;
  const ctx=load(async()=>{requests++;return {ok:false,headers:{get:()=>null},body:null};});
  for(let i=0;i<10;i++)await ctx.downloadRecentMediaWhileIdle('/api/attachment/content',{});
  assert.equal(requests,6);
});
test('interacting with the app interrupts background download',async()=>{
  const ctx=load((_path,options)=>new Promise((_resolve,reject)=>{
    options.signal.addEventListener('abort',()=>reject(Error('aborted')));
  }));
  const pending=ctx.downloadRecentMediaWhileIdle('/api/attachment/content',{});
  ctx.lastInteractionTime=Date.now();
  assert.equal(await pending,null);
});
test('unknown-length responses are stopped at the byte cap',async()=>{
  let cancelled=false;
  const ctx=load(async()=>({ok:true,headers:{get:()=>null},body:{getReader:()=>({
    read:async()=>({done:false,value:new Uint8Array(8*1024*1024+1)}),cancel:async()=>{cancelled=true;},
  })}}));
  assert.equal(await ctx.downloadRecentMediaWhileIdle('/api/attachment/content',{}),null);
  assert.equal(cancelled,true);
});
