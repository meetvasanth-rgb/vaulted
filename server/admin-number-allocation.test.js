const test=require('node:test');
const assert=require('node:assert/strict');
test('admin gifts require authentication and permit exactly one new owner', {timeout:15000},async t=>{
  const {spawn}=require('node:child_process');
  const {mkdtemp,rm}=require('node:fs/promises');
  const {tmpdir}=require('node:os');const {join}=require('node:path');
  const net=require('node:net');
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const directory=await mkdtemp(join(tmpdir(),'vaultlix-health-'));
  const vapid=require('web-push').generateVAPIDKeys();
  const child=spawn(process.execPath,['server/index.js'],{cwd:join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:String(port),ADMIN_KEY:'health-test-key',DATABASE_URL:'',REDIS_URL:'',SNAPSHOT_DIR:directory,VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await rm(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  const url=base+'/api/admin/health';
  let response;
  for(let i=0;i<60;i++){try{response=await fetch(url);break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.equal(response?.status,404);
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer wrong-key'}})).status,404);
  const post=async(path,body,key)=>{const response=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},body:JSON.stringify(body)});return {status:response.status,data:await response.json().catch(()=>({}))};};
  assert.equal((await post('/api/admin/allocate-number',{privateNumber:'234567'})).status,404);
  assert.equal((await post('/api/admin/allocate-number',{privateNumber:'123'},'health-test-key')).status,400);
  const gift=await post('/api/admin/allocate-number',{privateNumber:'234567'},'health-test-key');
  assert.equal(gift.status,200);assert.match(gift.data.claimUrl,/^https:\/\/vaultlix.com\/#g=234567\./);
  assert.equal((await post('/api/admin/allocate-number',{privateNumber:'234567'},'health-test-key')).status,409);
  const reservationToken=gift.data.claimUrl.split('.').at(-1);
  assert.equal(reservationToken.length,22);
  assert.ok(gift.data.claimUrl.length<=58);
  const payload={accountId:'a'.repeat(64),privateNumber:'234567',displayName:'Gift Friend',authSecret:'A'.repeat(43),recoverySecret:'B'.repeat(43),passwordWrap:'x'.repeat(30),recoveryWrap:'y'.repeat(30),bundle:'z'.repeat(30)};
  assert.equal((await post('/api/account/register',payload)).status,409);
  assert.equal((await post('/api/account/number-gift',{privateNumber:'234567',reservationToken:'C'.repeat(43)})).status,409);
  assert.equal((await post('/api/account/number-gift',{privateNumber:'234567',reservationToken})).status,200);
  const results=await Promise.all(['a','b'].map(id=>post('/api/account/register',{...payload,accountId:id.repeat(64),reservationToken})));
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  const owner=results.find(x=>x.status===200).data;
  assert.equal(owner.privateNumber,'234567');
  assert.equal((await post('/api/account/number-gift',{privateNumber:'234567',reservationToken})).status,409);
  assert.equal((await post('/api/admin/allocate-number',{privateNumber:'234567'},'health-test-key')).status,409);

});

test('database signup atomically consumes reservations and rolls back expired or replayed gifts',async()=>{
  const {PostgresStore}=require('./postgres');
  for(const mode of ['valid','expired','used','wrong-token','missing-token','existing','retired','write-failure']) {
    const calls=[];
    const client={async query(sql){calls.push(sql);if(sql.startsWith('SELECT account_id'))return {rows:mode==='existing'?[{}]:[]};if(sql.startsWith('SELECT private_number FROM'))return {rows:mode==='retired'?[{}]:[]};if(sql.startsWith('SELECT *'))return {rows:[{token_hash:'good',reserved_until:mode==='expired'?1:Date.now()+60000,assigned_account_id:mode==='used'?'owner':null}]};return {rows:[]};},release(){calls.push('release');}};
    const store=new PostgresStore('',{pool:{connect:async()=>client}});
    store.pool={connect:async()=>client};
    store.saveAccount=async(_id,_account,connection)=>{assert.equal(connection,client);calls.push('save');if(mode==='write-failure')throw Error('write failed');};
    const run=()=>store.registerReservedAccount('account',{privateNumber:'234567'},mode==='missing-token'?null:mode==='wrong-token'?'bad':'good');
    if(mode==='write-failure') await assert.rejects(run,/write failed/);
    else assert.equal(await run(),mode==='valid');
    assert.ok(calls.includes(mode==='valid'?'COMMIT':'ROLLBACK'));
    assert.equal(calls.at(-1),'release');
    if(mode==='valid')assert.ok(calls.find(sql=>sql.startsWith('UPDATE private_number_reservations')));
    else if(mode!=='write-failure')assert.equal(calls.includes('save'),false);
  }
});

test('claim link fills gifted signup without generating a replacement number',async()=>{
  const fs=require('node:fs'),vm=require('node:vm');const html=fs.readFileSync('client/index.html','utf8');
  const start=html.indexOf('async function openNumberGift()');const end=html.indexOf('function openCreateAccount()',start);
  const nodes={},requests=[];const context={pendingNumberGift:['','234567','T'.repeat(43)],loadAccountState:()=>null,api:async(path,body)=>{requests.push({path,body});return {privateNumber:'234567'};},document:{getElementById:id=>nodes[id] ||= {}},formatPrivateNumber:n=>n,openCreateAccount(){context.opened=true;},toast(){}};
  vm.createContext(context);vm.runInContext(html.slice(start,end),context);await context.openNumberGift();
  assert.equal(context.activeNumberGift,true);assert.equal(context.pendingPrivateNumber,'234567');assert.equal(context.pendingPrivateNumberReservation,'T'.repeat(43));assert.equal(context.opened,true);assert.equal(requests[0].path,'/api/account/number-gift');
  assert.equal(nodes['account-private-number-preference'].disabled,true);
});

test('gift URL parser accepts existing and compact links and rejects malformed tokens',()=>{
  const fs=require('node:fs'),vm=require('node:vm');
  const html=fs.readFileSync('client/index.html','utf8');
  const expression=html.match(/let pendingNumberGift = (.+);/)[1];
  for(const [hash,valid] of [['#numberGift=234567.'+'A'.repeat(43),true],['#g=234567.'+'B'.repeat(22),true],['#g=234567.short',false],['#g=123456.'+'B'.repeat(22),false]]) {
    const result=vm.runInNewContext(expression,{location:{hash}});
    assert.equal(!!result,valid);
    if(valid)assert.equal(result[1],'234567');
  }
});
