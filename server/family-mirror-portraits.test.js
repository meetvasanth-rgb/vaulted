'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,'index.js'),'utf8');
const context = vm.createContext({OPENAI_API_KEY:'configured',GEMINI_API_KEY:'',DAY_MS:86400000});
const start = source.indexOf('const DAILY_LOOK_STYLES =');
vm.runInContext(source.slice(start,source.indexOf('\n]);',start)+4),context);
const promptStart = source.indexOf('const SOURCE_PHOTO_ENHANCEMENT_PROMPT =');
vm.runInContext(source.slice(promptStart,source.indexOf('`;\n',promptStart)+2),context);
const directedStart=source.indexOf('function dailyLookDirectedPrompt(');
vm.runInContext(source.slice(directedStart,source.indexOf('\nfunction dailyLookCanvas',directedStart)),context);
const publicStart=source.indexOf('function publicDailyLookStyles(');
vm.runInContext(source.slice(publicStart,source.indexOf('\n}',publicStart)+2),context);
const styles=vm.runInContext('DAILY_LOOK_STYLES',context);

test('Professional and all five retired presets are absent from the selectable server catalog',()=>{
  const catalog=context.publicDailyLookStyles();
  assert.equal(catalog.some(style=>style.collection==='Professional'),false);
  for(const id of ['modern-professional','executive-portrait','creative-professional','healthcare-professional','speaker-author']) {
    assert.equal(styles.some(style=>style.id===id),false);
  }
});
test('first version exposes exactly two family enhancements and one mirror enhancement using OpenAI',()=>{
  assert.deepEqual(Array.from(styles.filter(style=>style.collection==='Family & Friends'),style=>style.id),['family-natural-group','family-indoor-rescue']);
  assert.deepEqual(Array.from(styles.filter(style=>style.collection==='Mirror Selfies'),style=>style.id),['mirror-selfie-enhance']);
  for(const style of styles.filter(style=>['Family & Friends','Mirror Selfies'].includes(style.collection))) {
    assert.equal(style.provider,'openai');
    assert.equal(context.publicDailyLookStyles().find(item=>item.id===style.id).available,true);
    assert.equal('prompt' in context.publicDailyLookStyles().find(item=>item.id===style.id),false);
  }
});
test('family enhancements preserve every identity and avoid studio scene replacement or blemish treatment',()=>{
  for(const id of ['family-natural-group','family-indoor-rescue']) {
    const prompt=context.dailyLookDirectedPrompt(styles.find(style=>style.id===id),0,'reduce');
    assert.match(prompt,/exact number of people/);
    assert.match(prompt,/Preserve children's actual age/);
    assert.match(prompt,/original relative skin tones|each face's exposure/);
    assert.match(prompt,/Preserve the source background, crop/);
    assert.match(prompt,/rather than inventing detail/);
    assert.doesNotMatch(prompt,/Blemish setting|Mandatory Gemini|new background|single-person crop/);
  }
});
test('mirror enhancement keeps occlusions, reflection geometry and the original surroundings',()=>{
  const prompt=context.dailyLookDirectedPrompt(styles.find(style=>style.id==='mirror-selfie-enhance'),0);
  assert.match(prompt,/Preserve the phone, phone case, camera, hands, fingers, grip, reflection/);
  assert.match(prompt,/Never flip the image, remove the phone, reveal or invent a face or body area hidden behind it/);
  assert.match(prompt,/without introducing a mirror, phone or reflection/);
  assert.doesNotMatch(prompt,/Blemish setting|studio-quality/);
});
