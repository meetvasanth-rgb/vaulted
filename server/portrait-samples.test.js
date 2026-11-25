'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),sharp=require('sharp');
const root=path.join(__dirname,'..');
const client=fs.readFileSync(path.join(root,'client/index.html'),'utf8');
const source=fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
function helpers(document){
  const context=vm.createContext({document,dailyLookSourceImage:'private-selected-photo'});
  const start=client.indexOf('const DAILY_LOOK_SAMPLE_IDS =');
  vm.runInContext(client.slice(start,client.indexOf('function renderDailyLookStyles(',start)),context);
  return context;
}
test('every visible preset has its own real, compact sample and thumbnail',async()=>{
  const context=vm.createContext({}); const start=source.indexOf('const DAILY_LOOK_STYLES =');
  vm.runInContext(source.slice(start,source.indexOf('\n]);',start)+4),context);
  const collections=['Selfies','Face Booster','Mirror Selfies','Family & Friends','Signature Studio','Lifestyle'];
  const styles=vm.runInContext('DAILY_LOOK_STYLES',context).filter(s=>collections.includes(s.collection));
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'client/portrait-samples/catalog.json'),'utf8'));
  const api=helpers({});
  assert.equal(Object.keys(catalog).length,styles.length);
  let total=0;
  for(const style of styles)for(const thumbnail of [false,true]){
    const url=api.dailyLookSampleAsset(style,thumbnail);
    assert.equal(url,catalog[style.id][thumbnail?'thumbnail':'preview']);
    const file=path.join(root,'client',url); const bytes=fs.statSync(file).size;total+=bytes;
    const meta=await sharp(file).metadata();
    assert.equal(meta.format,'webp');
    assert.ok(meta.width<=(thumbnail?320:768));assert.ok(meta.height<=(thumbnail?426:1024));
    assert.ok(bytes<(thumbnail?65000:250000),`${style.id} remains light to load`);
    assert.equal(meta.exif,undefined);
  }
  assert.ok(total<6*1024*1024,'full collection stays below 6 MB; thumbnails load lazily');
});
test('sample asset resolution rejects arbitrary paths and unshipped presets',()=>{
  const api=helpers({});
  assert.equal(api.dailyLookSampleAsset({id:'../../private'}),null);
  assert.equal(api.dailyLookSampleAsset({id:'https://example.com/photo'}),null);
  assert.equal(api.dailyLookSampleAsset(null),null);
});
test('sample viewer selection and dismissal preserve the private photo and do not generate',()=>{
  const oldFocus={isConnected:true,focus(){doc.activeElement=this;}};
  const studio={inert:false};
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.listeners={};this.isConnected=true;}
    append(...nodes){this.children.push(...nodes);}
    setAttribute(k,v){this.attrs[k]=v;}
    addEventListener(k,v){this.listeners[k]=v;}
    removeEventListener(k){delete this.listeners[k];}
    remove(){this.isConnected=false;}
    focus(){doc.activeElement=this;}
  }
  const doc={activeElement:oldFocus,body:new Element('body'),createElement:tag=>new Element(tag),querySelector:selector=>selector.includes('daily-look-card')?studio:null};
  const api=helpers(doc);let selected=0;
  const style={id:'selfie-polish',name:'Selfie Polish',note:'Natural selfie',available:true};
  api.openDailyLookSample(style,()=>selected++);
  assert.equal(studio.inert,true);
  const overlay=doc.body.children.at(-1),dialog=overlay.children[0];
  assert.equal(dialog.attrs.role,'dialog');
  const image=dialog.children.find(e=>e.tag==='img');
  assert.equal(image.src,'/portrait-samples/selfie-polish.v1.webp');
  image.onerror();assert.equal(image.hidden,true);
  const use=dialog.children.at(-1);use.onclick();
  assert.equal(selected,1);assert.equal(studio.inert,false);assert.equal(overlay.isConnected,false);
  assert.equal(api.dailyLookSourceImage,'private-selected-photo');
  api.openDailyLookSample(style,()=>selected++);
  const second=doc.body.children.at(-1);
  second.listeners.keydown({key:'Escape',preventDefault(){},stopPropagation(){}});
  assert.equal(selected,1);assert.equal(second.isConnected,false);assert.equal(studio.inert,false);
});
