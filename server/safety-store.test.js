'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {SafetyStore,SLA}=require('./safety-store');
const {check}=require('../client/content-safety');
test('local checks normalize abuse without matching harmless substrings',()=>{
  for(const text of ['I WILL KILL YOU','I will ki\u200bll you','Ｉ ｗｉｌｌ ｋｉｌｌ ｙｏｕ','je vais te tuer','child pornography','f@ggot','connard','scheiße']) assert.equal(check(text).blocked,true,text);
  for(const text of ['Hello there','User b','Scunthorpe','The killer whale is beautiful','I will call you']) assert.equal(check(text).blocked,false,text);
});
test('report workflow persists, enforces stale-update protection and never resurrects expired legacy reports',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vaultlix-safety-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  fs.writeFileSync(path.join(dir,'safety-reports.jsonl'),JSON.stringify({id:'legacy',createdAt:new Date(Date.now()-2*SLA).toISOString(),reason:'other'})+'\n');
  let store=new SafetyStore(dir);await store.initialize();
  const legacy=(await store.list())[0];assert.equal(legacy.overdue,true);
  const report=await store.add({reason:'threats',details:'Please review',messages:[]});
  assert.equal((await store.list()).find(r=>r.id===report.id).overdue,false);
  const reviewed=await store.review(report.id,'reviewing','Investigating',report.updatedAt);
  assert.notEqual(reviewed.updatedAt,report.updatedAt);
  await assert.rejects(()=>store.review(report.id,'resolved','Stale',report.updatedAt),/changed/);
  await assert.rejects(()=>store.review(report.id,'resolved','',reviewed.updatedAt),/note/);
  await store.block('account-a','account-b');
  await store.setSuspended('account-b',true);
  store=new SafetyStore(dir);await store.initialize();
  assert.equal(await store.blocked('account-b','account-a'),true);
  assert.equal(await store.isSuspended('account-b'),true);
  await store.setSuspended('account-b',false);
  assert.equal(await store.isSuspended('account-b'),false);
  assert.equal(await store.blocked('account-a','account-c'),false);
  assert.equal((await store.list()).find(r=>r.id===report.id).history[0].note,'Investigating');
  store.reports.set('legacy',{...legacy,status:'resolved',updatedAt:new Date(Date.now()-91*SLA).toISOString()});store.flush();
  assert.equal((await store.list()).some(r=>r.id==='legacy'),false);
  store=new SafetyStore(dir);await store.initialize();
  assert.equal((await store.list()).some(r=>r.id==='legacy'),false);
  assert.equal(fs.statSync(path.join(dir,'safety-workflow.json')).mode & 0o777,0o600);
});
test('hidden incoming content and inbox previews do not render unscreened text or attachments',()=>{
  const vm=require('node:vm');
  const html=fs.readFileSync(path.join(__dirname,'../client/index.html'),'utf8');
  const nodes=[];
  function node(tag){const n={tag,children:[],dataset:{},events:{},append(...items){this.children.push(...items);},addEventListener(event,callback){this.events[event]=callback;}};nodes.push(n);return n;}
  const body={insertBefore(n){this.last=n;}}, typing={};
  const context={document:{getElementById:id=>id==='chat-body'?body:typing,createElement:node},window:{VaultlixContentSafety:{check}},safetyRevealedRecords:new WeakSet(),openReportPanel(){},renderChatBody(){},secureNativeStoreMessage(){},uniqueVisibleConversationRecords:r=>r,i18n:key=>key};
  vm.createContext(context);
  for(const name of ['renderMessageRecord','vaultInboxPreview']){const start=html.indexOf('function '+name+'('),end=html.indexOf('\nfunction ',start+1);vm.runInContext(html.slice(start,end),context);}
  const malicious={kind:'text',isMe:false,content:'I will kill you',id:'text'};
  context.renderMessageRecord({},malicious,false);
  assert.equal(body.last.children[0].children[0].textContent,'Potentially harmful message hidden by on-device safety checks.');
  assert.equal(context.vaultInboxPreview({messages:[malicious]},true).text,'Potentially harmful message hidden');
  for(const kind of ['file','album','voice','gif','image']){
    context.renderMessageRecord({},{kind,isMe:false,id:kind},false);
    assert.match(body.last.children[0].children[0].textContent,/Attachment hidden/);
  }
  assert.equal(nodes.some(n=>['img','audio','video','iframe'].includes(n.tag)),false);
});
