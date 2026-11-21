'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { repairPollRestoreWindow } = require('./poll-restore-window');
const client = fs.readFileSync(require('node:path').join(__dirname, '../client/index.html'), 'utf8');
const isOwn = message => message.from === 'me';
const message = (seq, from, extra = {}) => ({ id:`m${seq}`, seq, from, type:'message', content:`encrypted-${seq}`, ts:seq, ...extra });
function clientFunction(name) {
  const start = client.indexOf(`function ${name}(`);
  const end = client.indexOf('\n}\n', start) + 2;
  return client.slice(start, end);
}
const context = vm.createContext({ HISTORY_LOAD_LIMIT:50, HISTORY_MAX_ENVELOPE_CHARS:256 * 1024 });
vm.runInContext(clientFunction('historyEnvelope') + '\n' + clientFunction('historyRestoreSyncPlan'), context);

test('reopen repairs sent timed texts omitted from both caches even below the saved cursor', () => {
  const retained = [message(1, 'peer'), message(2, 'me', {deleteTimerSeconds:1800}),
    message(3, 'peer'), message(4, 'me', {deleteTimerSeconds:1800})];
  const cached = retained.map(context.historyEnvelope).filter(Boolean);
  assert.deepEqual(cached.map(row => row.id), ['m1', 'm3']);
  const plan = context.historyRestoreSyncPlan({code:'room',token:'me',deleteTimerSeconds:1800}, cached);
  assert.equal(plan.mode, 'delta');
  assert.equal(plan.request.lastSeq, 3);
  assert.equal(plan.request.restoreWindowLimit, 50);
  // Previous request returns neither missing sent message: one is behind
  // the cursor and the other is excluded as an own send.
  assert.equal(retained.filter(row => row.seq > 3 && !isOwn(row)).length, 0);
  const restored = repairPollRestoreWindow({ delta:retained.filter(row => row.seq > 3), retained,
    limit:plan.request.restoreWindowLimit, isOwn });
  assert.deepEqual(restored.map(row => row.id), ['m1','m2','m3','m4']);
});

test('a lost send acknowledgement is recovered without duplicating cached peer texts', () => {
  const retained = [message(10,'me'), message(11,'peer'), message(12,'me')];
  const plan = context.historyRestoreSyncPlan({code:'room',token:'me'}, [retained[1]]);
  const restored = repairPollRestoreWindow({ delta:[retained[2]], retained, limit:plan.request.restoreWindowLimit, isOwn });
  const merged = new Map([[retained[1].id, retained[1]]]);
  for (const row of restored) merged.set(row.id, row);
  assert.deepEqual([...merged.values()].sort((a,b)=>a.seq-b.seq).map(row=>row.id), ['m10','m11','m12']);
});

test('repair never resurrects deleted or expired content, or echoes own join notices', () => {
  const retained = [message(1,'me',{deleted:true}), message(2,'peer',{expiresAt:100}),
    message(3,'me',{type:'system'}), message(4,'peer',{deleteTimerSeconds:1800,readAt:90,expiresAt:200})];
  const result = repairPollRestoreWindow({delta:retained, retained, limit:50, isOwn, now:150});
  assert.deepEqual(result.map(row=>row.id), ['m4']);
  assert.equal(result[0].readAt, 90);
  assert.equal(result[0].expiresAt, 200);
});

test('bounded repair preserves the complete new delta and orders the union once', () => {
  const retained = Array.from({length:120}, (_,i)=>message(i+1, i%2?'me':'peer'));
  const result = repairPollRestoreWindow({delta:retained.slice(80),retained,limit:5,isOwn});
  assert.equal(result.length, 40);
  assert.equal(result[0].seq, 81);
  assert.equal(result.at(-1).seq, 120);
  assert.equal(repairPollRestoreWindow({delta:[],retained,limit:500,isOwn}).length,100);
});

test('only restore requests opt into repair; ordinary polling keeps its own-send filter', () => {
  const server = fs.readFileSync(require('node:path').join(__dirname,'index.js'),'utf8');
  assert.match(server, /return includeOwn \|\| restoreWindowLimit > 0 \|\| !messageFromToken\(msg, token\)/);
  assert.match(server, /if \(restoreWindowLimit\) newMsgs = repairPollRestoreWindow/);
  assert.match(server, /if \(msg.type==='message' && !messageFromToken\(msg, token\) && !msg.deliveredAt\)/);
});

test('real poll restores both directions on reopen without falsely delivering own sends', {timeout:20000}, async t => {
  const {spawn} = require('node:child_process');
  const {createServer} = require('node:net');
  const {mkdtemp,rm} = require('node:fs/promises');
  const {join} = require('node:path');
  const listener = createServer();
  await new Promise((resolve,reject)=>listener.listen(0,'127.0.0.1',resolve).once('error',reject));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const directory = await mkdtemp(join(require('node:os').tmpdir(),'vaultlix-reopen-'));
  const vapid=require('web-push').generateVAPIDKeys();
  const child=spawn(process.execPath,['server/index.js'],{cwd:join(__dirname,'..'),
    env:{...process.env,NODE_ENV:'test',PORT:String(port),SNAPSHOT_DIR:directory,
      DATABASE_URL:'',REDIS_URL:'',VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey},
    stdio:['ignore','pipe','pipe']});
  t.after(async()=>{
    if(child.exitCode===null) {
      const exited = new Promise(resolve=>child.once('exit',resolve));
      child.kill('SIGTERM'); await exited;
    }
    await rm(directory,{recursive:true,force:true});
  });
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('test server did not start')),6000);
    child.stdout.on('data',chunk=>{if(chunk.toString().includes(`Vaultlix on port ${port}`)){clearTimeout(timeout);resolve();}});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`server exited ${code}`));});
  });
  const post=async(path,data)=>{
    const response=await fetch(`http://127.0.0.1:${port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});
    assert.equal(response.status,200);return response.json();
  };
  const sender=await post('/api/create',{name:'Sender'});
  const peer=await post('/api/join',{code:sender.code,name:'Peer'});
  const auth={code:sender.code,token:sender.token};
  await post('/api/send',{...auth,msgId:'cached-old',content:'ciphertext-old'});
  await post('/api/set-timer',{...auth,deleteTimer:1800});
  const sent=await post('/api/send',{...auth,msgId:'own-missing',content:'ciphertext-own'});
  const received=await post('/api/send',{code:sender.code,token:peer.token,msgId:'peer-cached',content:'ciphertext-peer'});
  const latest=await post('/api/send',{...auth,msgId:'own-latest',content:'ciphertext-latest'});
  const ordinary=await post('/api/poll',{...auth,lastSeq:received.seq});
  assert.deepEqual(ordinary.messages,[]);
  const repaired=await post('/api/poll',{...auth,lastSeq:received.seq,restoreWindowLimit:50});
  assert.deepEqual(repaired.messages.filter(row=>row.type==='message').map(row=>row.id),['cached-old','own-missing','peer-cached','own-latest']);
  const own=repaired.messages.find(row=>row.id==='own-latest');
  assert.equal(own.from,sender.token);
  assert.equal(own.deliveredAt,null,'reopen is not evidence the peer received this message');
  assert.equal(own.deleteTimerSeconds,1800,'the timer survives repair');
  assert.equal(repaired.messages.find(row=>row.id==='own-missing').seq,sent.seq);
  assert.equal(own.seq,latest.seq);
  assert.ok(repaired.messages.find(row=>row.id==='peer-cached').deliveredAt);
});
