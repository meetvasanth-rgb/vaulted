'use strict';
const test = require('node:test'),assert = require('node:assert/strict'),fs = require('node:fs'),vm = require('node:vm');
const html=fs.readFileSync('client/index.html','utf8'),admin=fs.readFileSync('client/admin.js','utf8');
function extract(source,name){const start=source.indexOf(`function ${name}(`);assert.notEqual(start,-1);let parens=0,end=source.indexOf('(',start);for(;end<source.length;end++){if(source[end]==='(')parens++;if(source[end]===')'&&--parens===0)break;}let level=0;for(let i=source.indexOf('{',end);i<source.length;i++){if(source[i]==='{')level++;if(source[i]==='}'&&--level===0)return source.slice(source.slice(start-6,start)==='async '?start-6:start,i+1);}throw Error('Function missing');}
async function viewer(copy={}){
 const item={id:'test-update',viewOnce:false,expiresAt:Date.now()+60000,mediaType:'video',mediaUrl:'https://vaultlix.com/test.mp4',...copy};let overlay;
 const node={setAttribute(){},querySelector(selector){return selector==='video'?{play:()=>Promise.resolve(),pause(){}}:{}},remove(){}};
 const context=vm.createContext({Date,String,document:{createElement:()=>node,body:{appendChild:n=>{overlay=n}}},vaultlixUpdates:[item],vaultlixUpdatesRefreshedAt:Date.now(),escHtml:s=>String(s).replaceAll('<','&lt;'),toast(){},refreshVaultlixUpdates:async()=>{}});
 vm.runInContext(extract(html,'openVaultlixUpdate'),context);await context.openVaultlixUpdate(item.id);return overlay.innerHTML;
}
test('a plain video has no title, message, caption container, gradient panel, or default label',async()=>{
 const markup=await viewer({title:' ',body:''});assert.match(markup,/<video /);assert.doesNotMatch(markup,/vaultlix-update-copy|<strong>|<p>|Vaultlix update|undefined|null/);assert.match(markup,/aria-label="Close"/);
});
test('a deliberately supplied title or message still renders; an optional button alone has no caption gradient',async()=>{
 let markup=await viewer({title:'Portrait Studio',body:'Try a new look'});assert.match(markup,/<strong>Portrait Studio<\/strong><p>Try a new look<\/p>/);
 markup=await viewer({title:'',body:'<hello>'});assert.doesNotMatch(markup,/<strong>/);assert.match(markup,/<p>&lt;hello><\/p>/);
 markup=await viewer({title:'',body:'',ctaAction:'daily-look',ctaLabel:'Try now'});assert.match(markup,/vaultlix-update-copy cta-only/);assert.match(markup,/Try now/);assert.doesNotMatch(markup,/<strong>|<p>/);
});
test('the admin preview hides blank fields and the composer does not require text for video-only updates',()=>{
 const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,{value:'',checked:false,hidden:false,classList:{toggle(){}}});return nodes.get(id)};
 $('announcement-audience').value='test';$('announcement-expiry').value='12';
 const context=vm.createContext({$,announcementThumbnailDataUrl:'',announcementMediaDataUrl:'data:video/mp4;base64,abcd'});vm.runInContext(extract(admin,'updateAnnouncementPreview'),context);context.updateAnnouncementPreview();
 assert.equal($('announcement-preview-title').textContent,'');assert.equal($('announcement-preview-title').hidden,true);assert.equal($('announcement-preview-body').textContent,'');assert.equal($('announcement-preview-body').hidden,true);
 $('announcement-title').value='Portrait Studio';context.updateAnnouncementPreview();assert.equal($('announcement-preview-title').hidden,false);
 const form=fs.readFileSync('client/admin.html','utf8');assert.doesNotMatch(form,/<input[^>]*id="announcement-title"[^>]*(?:required|value="Vaultlix update")/);assert.doesNotMatch(form,/<textarea[^>]*id="announcement-body"[^>]*required/);
});
test('an untitled inbox preview has no dangling separator or invented title',()=>{
 const context=vm.createContext({escHtml:String,formatVaultInboxTime:()=>''});vm.runInContext(extract(html,'vaultlixUpdateRowHtml'),context);
 const markup=context.vaultlixUpdateRowHtml({id:'test',mediaType:'video',title:''});assert.match(markup,/vault-list-row-preview">Video update<\/span>/);assert.doesNotMatch(markup,/Video update ·|undefined/);
});
test('native and web announcement handlers retain intentionally empty copy instead of treating it as a chat notification',()=>{
 const java=fs.readFileSync('mobile/android/app/src/main/java/com/vaultlix/app/VaultlixMessagingService.java','utf8'),service=java.slice(java.indexOf('private void showAnnouncementNotification('),java.indexOf('private void showAnnouncementNotification(')+3500);
 assert.match(service,/\.setContentTitle\(title\)/);assert.match(service,/\.setContentText\(body\)/);assert.doesNotMatch(service,/Vaultlix update|Open Vaultlix to see/);
 const worker=fs.readFileSync('client/sw.js','utf8');assert.match(worker,/data\.announcement \? \(data\.title \|\| ''\)/);assert.match(worker,/data\.announcement \? \(data\.body \|\| ''\)/);
 const server=fs.readFileSync('server/index.js','utf8');assert.match(server,/validateAnnouncement\(d, \{ hasMedia:!!decodedMedia\.value \}\)/);assert.match(server,/parsed\.announcement \? \(parsed\.title \|\| ''\)/);assert.match(server,/parsed\.announcement \? \(parsed\.body \|\| ''\)/);
});
