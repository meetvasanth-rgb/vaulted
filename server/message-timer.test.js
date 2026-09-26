const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const webpush = require('web-push');

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function post(base, path, body) {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.json();
}

test('timer changes never expire earlier untimed messages and old timed messages retain their setting', { timeout: 15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-expiry-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PORT: String(port),
      SNAPSHOT_DIR: snapshotDir,
      VAPID_PUBLIC_KEY: vapid.publicKey,
      VAPID_PRIVATE_KEY: vapid.privateKey,
      TEST_ONE_TIME_ROOM_TTL_MS: '60000',
      TEST_ROOM_EXPIRY_SWEEP_MS: '25',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive: true, force: true });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  const created = await post(base, '/api/create', { name: 'Expiry test' });
  assert.ok(created.code && created.token);

  const peer = await post(base,'/api/join',{code:created.code,name:'Peer'});
  assert.ok(peer.token);
  const auth={code:created.code,token:created.token};
  const send=async id=>{const result=await post(base,'/api/send',{...auth,msgId:id,content:'ciphertext'});assert.equal(result.ok,true);};
  await send('before');
  await post(base,'/api/set-timer',{...auth,deleteTimer:1});
  await send('timed');
  await post(base,'/api/set-timer',{...auth,deleteTimer:0});
  await send('after');
  let poll=await post(base,'/api/poll',{code:created.code,token:peer.token,lastSeq:0,full:1});
  assert.deepEqual(poll.messages.filter(m=>m.type==='message').map(m=>[m.id,m.deleteTimerSeconds]),[['before',0],['timed',1],['after',0]]);
  await post(base,'/api/read',{code:created.code,token:peer.token,msgIds:['before','timed','after']});
  const receipts=await post(base,'/api/poll',{...auth,lastSeq:0,lastReceiptSeq:0});
  assert.deepEqual(receipts.readReceipts.map(r=>[r.msgId,r.deleteTimerSeconds]),[['before',0],['timed',1],['after',0]]);
  await new Promise(resolve=>setTimeout(resolve,5500));
  poll=await post(base,'/api/poll',{code:created.code,token:peer.token,lastSeq:0,full:1});
  assert.deepEqual(poll.messages.filter(m=>m.type==='message').map(m=>m.id),['before','after']);
  const noticeChange={...auth,deleteTimer:60,noticeId:'timer-notice',noticeContent:'v:encrypted-notice'};
  const update=await post(base,'/api/set-timer',noticeChange);
  assert.equal(update.notice.id,'timer-notice');
  await post(base,'/api/set-timer',noticeChange);
  poll=await post(base,'/api/poll',{code:created.code,token:peer.token,lastSeq:0,full:1});
  const notices=poll.messages.filter(m=>m.id==='timer-notice');
  assert.equal(notices.length,1);assert.equal(notices[0].deleteTimerSeconds,0);
  assert.equal(notices[0].content,'v:encrypted-notice');

});

const vm = require('node:vm');
const source = require('node:fs').readFileSync(join(__dirname,'../client/index.html'),'utf8');
function clientFunction(name) {
  const start=source.indexOf('function '+name+'(');
  return source.slice(start,source.indexOf('\n}',start)+2);
}
test('client ignores room timer for old messages and repeated reads never extend a countdown',()=>{
  const scheduled=[];
  const context={api:()=>Promise.resolve({}),Date:{now:()=>10000},activeRoomCode:null,persistDeleteLedger(){},setTimeout:(fn,ms)=>{scheduled.push(ms);return scheduled.length;},removeMessageRecord(){}};
  vm.createContext(context);
  for(const name of ['confirmRead','startReceiveDeleteTimer','startDeleteTimer','handleReadReceipts'])vm.runInContext(clientFunction(name),context);
  const old={id:'old',deleteTimerSeconds:0},current={id:'new',deleteTimerSeconds:60};
  const room={messages:[old,current],deleteTimerSeconds:60,deleteLedger:new Map(),msgTimers:new Map()};
  context.confirmRead(room,['old','new']);
  assert.equal(old.deleteAt,undefined);assert.equal(current.deleteAt,70000);
  context.confirmRead(room,['old','new']);assert.deepEqual(scheduled,[60000]);
  const sent={id:'sent'};room.messages.push(sent);room.deleteTimerSeconds=0;
  context.handleReadReceipts(room,[{msgId:'sent',readAt:5000,deleteTimerSeconds:60}]);
  assert.equal(sent.deleteAt,65000);assert.equal(scheduled.at(-1),55000);
  context.handleReadReceipts(room,[{msgId:'old',readAt:5000,deleteTimerSeconds:0}]);
  assert.equal(old.deleteAt,undefined);
});
test('timer changes insert timestamped chat notices without success toasts',async()=>{
  const notices=[];const room={code:'room',messages:[],deleteTimerSeconds:0};let id=0;
  const context={getActiveRoom:()=>room,newMsgId:()=>`timer-${++id}`,encryptMsg:async(_,text)=>'v:'+text,api:async(_,body)=>({deleteTimer:body.deleteTimer,notice:{id:body.noticeId,ts:1000}}),persistRoom(){},showTimerChip(){},updateTimerBar(){},toast:s=>notices.push(s),formatDuration:s=>s+'s',formatMsgTime:()=> '16:14',secureNativeStoreMessage(){},activeRoomCode:'room',renderChatBody(){}};
  vm.createContext(context);vm.runInContext(clientFunction('timerNoticeRecord')+'\nasync '+clientFunction('changeRoomTimer'),context);
  await context.changeRoomTimer('60');await context.changeRoomTimer('0');
  assert.equal(notices.length,0);assert.equal(room.messages.length,2);
  assert.match(room.messages[0].content,/on.*60s.*16:14/);
  assert.match(room.messages[1].content,/off.*16:14/);
  for(const rec of room.messages){assert.equal(rec.kind,'sys');assert.equal(rec.timerEvent,true);assert.equal(rec.deleteTimerSeconds,0);}
  vm.runInContext(clientFunction('isVisibleConversationRecord'),context);
  assert.equal(context.isVisibleConversationRecord(room.messages[0]),true);
  assert.equal(context.isVisibleConversationRecord({kind:'sys',content:'Joined'}),false);
});
