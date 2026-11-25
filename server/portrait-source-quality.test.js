'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');
const server = fs.readFileSync(path.join(__dirname,'index.js'),'utf8');

function prepareHarness(width,height,encodedSize=()=>1000) {
  const frames=[],qualities=[];
  let revoked=0;
  const canvas={width:0,height:0,getContext:()=>({fillRect(){},drawImage(){frames.push([canvas.width,canvas.height]);}}),toDataURL(type,quality){qualities.push(quality);return {length:encodedSize(canvas.width,canvas.height,quality)};}};
  const context=vm.createContext({
    URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>revoked++},
    Image:class {constructor(){this.naturalWidth=width;this.naturalHeight=height;}set src(value){this.onload();}},
    document:{createElement:()=>canvas},requestAnimationFrame:callback=>callback(),
  });
  const start=client.indexOf('async function prepareDailyLookImage(');
  vm.runInContext(client.slice(start,client.indexOf('\nasync function saveProfileImageUpdate',start)),context);
  return {prepare:context.prepareDailyLookImage,frames,qualities,get revoked(){return revoked;}};
}
const photo={name:'group.jpg',type:'image/jpeg',size:24*1024*1024};

test('large group source retains 4096px detail with a bounded canvas and original export dimensions',async()=>{
  const h=prepareHarness(8000,6000);
  const result=await h.prepare(photo);
  assert.deepEqual(h.frames,[[4000,3000]]);
  assert.equal(result.width,8000);
  assert.equal(result.height,6000);
  assert.deepEqual(h.qualities,[.94]);
  assert.equal(h.revoked,1);
});
test('landscape group source reaches 4096px and small photos are never upscaled',async()=>{
  const wide=prepareHarness(6000,3000);
  await wide.prepare(photo);
  assert.deepEqual(wide.frames,[[4096,2048]]);
  const small=prepareHarness(1200,900);
  await small.prepare(photo);
  assert.deepEqual(small.frames,[[1200,900]]);
});
test('oversized encoded source reduces dimensions at high quality instead of crushing JPEG quality',async()=>{
  const h=prepareHarness(6000,3000,w=>w>3300?9*1024*1024:1000);
  await h.prepare(photo);
  assert.deepEqual(h.frames,[[4096,2048],[3277,1638]]);
  assert.deepEqual(h.qualities,[.94,.92,.9,.88,.94]);
});
test('unpreparable photos fail with bounded work and release their temporary URL',async()=>{
  const h=prepareHarness(6000,3000,()=>9*1024*1024);
  await assert.rejects(h.prepare(photo),/could not be prepared safely/);
  assert.equal(h.frames.length,4);
  assert.equal(h.revoked,1);
});
test('25 MB original limit remains enforced before image decoding',async()=>{
  const h=prepareHarness(6000,3000);
  await assert.rejects(h.prepare({...photo,size:25*1024*1024+1}),/up to 25 MB/);
  assert.equal(h.frames.length,0);
});
test('server accepts prepared images beyond the old 900 KB cap but rejects above 6 MB',()=>{
  const context=vm.createContext({Buffer});
  const start=server.indexOf('function parseDailyLookImage(');
  vm.runInContext(server.slice(start,server.indexOf('\nfunction validDailyLookDimensions',start)),context);
  const uri=size=>'data:image/jpeg;base64,'+Buffer.alloc(size,1).toString('base64');
  assert.equal(context.parseDailyLookImage(uri(6*1024*1024)).bytes.length,6*1024*1024);
  assert.equal(context.parseDailyLookImage(uri(6*1024*1024+1)),null);
  assert.equal(context.parseDailyLookImage('data:text/html;base64,AAAA'),null);
});
