const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../client/index.html'), 'utf8');
function context() {
  const writes = [];
  const ctx = vm.createContext({
    Map, Object, Number, setTimeout, clearTimeout,
    loadAccountState: () => ({accountId:'owner'}), rooms:new Map(),
    secureNativeStoreCompactMessage: (...args) => writes.push(args),
    document:{addEventListener: () => {}}, nativeMessageCacheEligible: () => true,
  });
  vm.runInContext(source.slice(source.indexOf('const CHAT_NEAR_BOTTOM_PX = 96;'), source.indexOf('function captureChatScrollAnchor(')), ctx);
  return {ctx, writes};
}
test('restores the same message offset after earlier rows change height', () => {
  const {ctx} = context();
  const row = {dataset:{msgId:'photo'}, getBoundingClientRect: () => ({top:140,bottom:400})};
  const body = {clientHeight:500, scrollHeight:2200, scrollTop:300, dataset:{layoutCode:'room'},
    getBoundingClientRect: () => ({top:100}), querySelectorAll: () => [row]};
  ctx.captureConversationViewport(body, 'room');
  row.getBoundingClientRect = () => ({top:240,bottom:500});
  assert.equal(ctx.restoreConversationViewport(body,'room'),true);
  assert.equal(body.scrollTop,400);
});
test('bottom-pinned readers remain at the newest messages', () => {
  const {ctx} = context();
  ctx.restoreConversationLayout('room', {kind:'conversation-layout', scroll:{bottom:true},media:{}});
  const body={clientHeight:500,scrollHeight:3000,scrollTop:0};
  ctx.restoreConversationViewport(body,'room');
  assert.equal(body.scrollTop,3000);
});
test('a fresh chat open overrides an older saved reading position', () => {
  const {ctx} = context();
  ctx.restoreConversationLayout('room',{kind:'conversation-layout',scroll:{bottom:false,id:'old',offset:20},media:{}});
  const body={dataset:{},clientHeight:500,scrollHeight:4000,scrollTop:200};
  ctx.beginLatestConversationOpen(body,'room');
  ctx.restoreConversationViewport(body,'room');
  assert.equal(body.scrollTop,4000);
  assert.equal(body.dataset.followLatest,'1');
});
test('out-of-order restored direct messages are displayed in timestamp order', () => {
  const ctx=vm.createContext({Set,Number,isVisibleConversationRecord:()=>true});
  vm.runInContext(source.slice(source.indexOf('function uniqueVisibleConversationRecords('),source.indexOf('function vaultLastActivity(')),ctx);
  const records=[{id:'new',kind:'text',ts:300},{id:'old',kind:'text',ts:100},{id:'middle',kind:'text',ts:200}];
  const rendered=ctx.uniqueVisibleConversationRecords(records);
  assert.deepEqual(Array.from(rendered,record=>record.id),['old','middle','new']);
  assert.equal(records[0].id,'new');
});
test('native saved layout merges into an early empty layout without losing dimensions', () => {
  const {ctx} = context();
  ctx.conversationLayout('room');
  ctx.restoreConversationLayout('room',{kind:'conversation-layout',scroll:{id:'older',bottom:false,offset:12},media:{'photo:':{width:300,height:600}}});
  assert.equal(ctx.conversationLayout('room').scroll.id,'older');
  assert.equal(ctx.conversationLayout('room').media['photo:'].height,600);
});
test('saved portrait dimensions reserve the same aspect ratio before decoding', () => {
  const {ctx} = context();
  ctx.restoreConversationLayout('room',{kind:'conversation-layout',media:{'photo:':{width:300,height:600}}});
  const row = {dataset:{msgId:'photo'}};
  const image={style:{},complete:false,matches: () => true,addEventListener: () => {},closest: selector => selector.includes('data-msg-id')?row:null};
  ctx.applyConversationMediaLayout({dataset:{},querySelectorAll: selector => selector.startsWith('img')?[image]:[]},'room');
  assert.equal(image.width,300); assert.equal(image.height,600);
  assert.equal(image.style.aspectRatio,'300/600');
});
test('persisted layout is an encrypted metadata record with a bounded dimensions list', async () => {
  const {ctx,writes} = context();
  const layout=ctx.conversationLayout('room');
  for(let i=0;i<200;i++) layout.media[`image${i}:`]={width:100,height:200};
  ctx.persistConversationLayout('room');
  await new Promise(resolve => setTimeout(resolve,350));
  assert.equal(writes[0][2].kind,'conversation-layout');
  assert.equal(Object.keys(writes[0][2].media).length,150);
});
