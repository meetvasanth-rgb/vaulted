'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');
function extract(name){const start=source.indexOf(`function ${name}(`);return source.slice(start,source.indexOf('\n}\n',start)+2);}
test('sand frames move between seeds, preserve the input pixels and remain fully opaque',()=>{
  const context=vm.createContext({});vm.runInContext(extract('dailyLookSandFrame'),context);
  const pixels=new Uint8ClampedArray(16*16*4).fill(120),original=Array.from(pixels);
  const first=context.dailyLookSandFrame(pixels,16,16,123),second=context.dailyLookSandFrame(pixels,16,16,456);
  assert.notDeepEqual(Array.from(first),Array.from(second));
  assert.deepEqual(Array.from(pixels),original);
  assert.deepEqual(Array.from(context.dailyLookSandFrame(pixels,16,16,123)),Array.from(first));
  for(let i=3;i<first.length;i+=4)assert.equal(first[i],255);
});
test('sand playback uses six small reusable frames and clears every scheduled frame and pixel buffer on stop',()=>{
  const queued=new Map(),painted=[],classes=new Set();let id=0;
  const imageContext={createImageData:(w,h)=>({data:new Uint8ClampedArray(w*h*4)}),putImageData:frame=>painted.push(frame),drawImage(){},getImageData:(_x,_y,w,h)=>({data:new Uint8ClampedArray(w*h*4).fill(120)})};
  const canvases=[];
  const document={createElement(){const canvas={setAttribute(){},getContext:()=>imageContext,remove(){this.removed=true;}};canvases.push(canvas);return canvas;}};
  const context=vm.createContext({document,window:{matchMedia:()=>({matches:false})},requestAnimationFrame:callback=>{queued.set(++id,callback);return id;},cancelAnimationFrame:id=>queued.delete(id)});
  vm.runInContext(extract('dailyLookSandFrame')+'\n'+extract('startDailyLookSandAnimation'),context);
  const stage={append(){},classList:{add:name=>classes.add(name),remove:name=>classes.delete(name)}};
  const stop=context.startDailyLookSandAnimation({naturalWidth:8000,naturalHeight:6000},stage);
  for(let i=0;i<6;i++){const [key,callback]=queued.entries().next().value;queued.delete(key);callback(i*20);}
  assert.equal(canvases[0].width,320);assert.equal(canvases[0].height,240);
  assert.equal(classes.has('has-sand'),true);assert.equal(queued.size,1);
  const [key,play]=queued.entries().next().value;queued.delete(key);play(1000);
  assert.equal(queued.size,1);assert.ok(painted.length>=2);
  stop();assert.equal(queued.size,0);assert.equal(classes.has('has-sand'),false);
  assert.equal(canvases[0].width,0);assert.equal(canvases[0].removed,true);
  assert.equal(painted[0].data.every(value=>value===0),true);
});
test('reduced motion and unavailable canvas keep the normal photo instead of failing creation',()=>{
  const context=vm.createContext({window:{matchMedia:()=>({matches:true})},document:{createElement(){throw Error('should not allocate');}}});
  vm.runInContext(extract('startDailyLookSandAnimation'),context);
  context.startDailyLookSandAnimation({}, {})();
  context.window.matchMedia=()=>({matches:false});
  context.document.createElement=()=>({setAttribute(){},getContext(){throw Error('canvas unavailable');}});
  assert.doesNotThrow(()=>context.startDailyLookSandAnimation({}, {})());
});
