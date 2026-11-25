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
    if(style.collection==='Mirror Selfies') assert.ok(meta.width/meta.height>1.4 && meta.width/meta.height<1.6,'mirror comparisons keep both portrait panels visible');
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

function sliderHarness(reducedMotion=false){
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.attrs={};this.values={};this.classes=new Set();this.style={setProperty:(key,value)=>{this.values[key]=value;}};this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name)};}
    append(...elements){this.children.push(...elements);}
    setAttribute(key,value){this.attrs[key]=value;}
  }
  const document={createElement:tag=>new Element(tag)};
  const context=helpers(document);
  context.window={matchMedia:()=>({matches:reducedMotion})};
  return context;
}
test('mirror slider animates the paired sample and manual input takes over without restarting',()=>{
  const api=sliderHarness();
  const stage=api.createDailyLookComparisonSlider({id:'mirror-cleanup',name:'Mirror Cleanup'});
  const [after,before]=stage.children;
  assert.match(after.className,/is-after/);assert.match(before.className,/is-before/);
  assert.equal(after.children[0].src,'/portrait-samples/mirror-cleanup.v2.webp');
  assert.equal(before.children[0].src,after.children[0].src);
  after.children[0].onload();assert.equal(stage.classes.has('is-animating'),false,'wait for both halves before the wipe');
  before.children[0].onload();assert.equal(stage.classes.has('is-animating'),true);
  const range=stage.children.find(element=>element.tag==='input');
  assert.equal(range.type,'range');assert.equal(range.min,'0');assert.equal(range.max,'100');
  range.value='23';range.oninput();
  assert.equal(stage.values['--reveal'],'23%');
  assert.equal(range.attrs['aria-valuetext'],'23% before, 77% after');
  assert.equal(stage.classes.has('is-animating'),false);
  after.children[0].onload();assert.equal(stage.classes.has('is-animating'),false);
  range.value='100';range.oninput();assert.equal(stage.values['--reveal'],'100%');
  range.value='0';range.oninput();assert.equal(stage.values['--reveal'],'0%');
});
test('reduced motion keeps the mirror slider still and thumbnails never capture browsing gestures',()=>{
  const api=sliderHarness(true);
  const stage=api.createDailyLookComparisonSlider({id:'mirror-selfie-enhance',name:'Mirror Enhance'},{thumbnail:true});
  stage.children[0].children[0].onload();
  assert.equal(stage.classes.has('is-animating'),false);
  assert.equal(stage.attrs['aria-hidden'],'true');
  assert.equal(stage.children.some(element=>element.tag==='input'),false);
  assert.equal(stage.values['--reveal'],'50%');
});
test('other collections retain ordinary sample images, and mirror image errors reach the fallback',()=>{
  const api=sliderHarness();let errors=0;
  assert.equal(api.createDailyLookComparisonSlider({id:'selfie-polish'}),null);
  const stage=api.createDailyLookComparisonSlider({id:'mirror-cleanup'},{onError:()=>errors++});
  stage.children[0].children[0].onerror();assert.equal(errors,1);
});
