'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createHealthMonitor}=require('./system-health');

test('health checks share in-flight work, cache snapshots and record bounded transitions',async()=>{
  let now=100000, calls=0, fail=false;
  const health=createHealthMonitor({now:()=>now,checks:[{id:'db',name:'Database',run:async()=>{calls++;if(fail)throw Error('SECRET connection string');return {status:'healthy',detail:'Query succeeded'};}}]});
  const [a,b]=await Promise.all([health(),health()]);assert.deepEqual(a,b);assert.equal(calls,1);
  await health();assert.equal(calls,1);
  fail=true;now+=30001;
  const failed=await health();assert.equal(failed.status,'down');assert.equal(failed.history.length,1);
  assert.equal(JSON.stringify(failed).includes('SECRET'),false);
  for(let i=0;i<45;i++){fail=!fail;now+=30001;await health();}
  assert.equal((await health()).history.length,40);
});
test('timeouts abort probes, unknown provider status does not masquerade as healthy',async()=>{
  let aborted=false;
  const health=createHealthMonitor({timeout:10,checks:[{id:'provider',name:'Provider',external:true,run:signal=>new Promise(()=>signal.addEventListener('abort',()=>aborted=true))}]});
  const result=await health();assert.equal(aborted,true);assert.equal(result.status,'warning');assert.equal(result.services[0].status,'unknown');
});
test('configuration is explicitly distinct from successful live probes',async()=>{
  const health=createHealthMonitor({checks:[{id:'push',name:'Push',run:async()=>({status:'configured',detail:'Not tested'})}]});
  assert.equal((await health()).services[0].status,'configured');
});

test('health endpoint rejects missing and incorrect admin credentials', {timeout:10000},async t=>{
  const {spawn}=require('node:child_process');
  const {mkdtemp,rm}=require('node:fs/promises');
  const {tmpdir}=require('node:os');const {join}=require('node:path');
  const net=require('node:net');
  const port=await new Promise(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
  const directory=await mkdtemp(join(tmpdir(),'vaultlix-health-'));
  const vapid=require('web-push').generateVAPIDKeys();
  const child=spawn(process.execPath,['server/index.js'],{cwd:join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:String(port),ADMIN_KEY:'health-test-key',DATABASE_URL:'',REDIS_URL:'',SNAPSHOT_DIR:directory,VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey},stdio:'ignore'});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}await rm(directory,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${port}/api/admin/health`;
  let response;
  for(let i=0;i<60;i++){try{response=await fetch(url);break;}catch{await new Promise(resolve=>setTimeout(resolve,50));}}
  assert.equal(response?.status,404);
  assert.equal((await fetch(url,{headers:{Authorization:'Bearer wrong-key'}})).status,404);
});
