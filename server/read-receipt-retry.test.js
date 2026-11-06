'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const webpush = require('web-push');

async function freePort() {
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',resolve).once('error',reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
async function post(base,path,body) {
  const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  return response.json();
}

test('a lost read-receipt response is replayed per device until its read cursor advances', { timeout:15000 }, async t => {
  const port=await freePort();
  const directory=await mkdtemp(join(tmpdir(),'vaultlix-read-retry-'));
  const vapid=webpush.generateVAPIDKeys();
  const child=spawn(process.execPath,['server/index.js'],{cwd:join(__dirname,'..'),env:{...process.env,NODE_ENV:'test',PORT:String(port),SNAPSHOT_DIR:directory,VAPID_PUBLIC_KEY:vapid.publicKey,VAPID_PRIVATE_KEY:vapid.privateKey},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null)child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));await rm(directory,{recursive:true,force:true});});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('test server did not start')),5000);child.stdout.on('data',chunk=>{if(chunk.toString().includes(`Vaultlix on port ${port}`)){clearTimeout(timer);resolve();}});child.once('exit',code=>reject(Error(`test server exited early (${code})`)));});
  const base=`http://127.0.0.1:${port}`;
  const sender=await post(base,'/api/create',{name:'Sender'});
  const reader=await post(base,'/api/join',{code:sender.code,name:'Reader'});
  await post(base,'/api/send',{code:sender.code,token:sender.token,msgId:'retry-read',content:'ciphertext'});
  const readerPoll=await post(base,'/api/poll',{code:sender.code,token:reader.token,lastSeq:0,lastReceiptSeq:0,lastReadReceiptSeq:0});
  const sequence=readerPoll.messages.find(message=>message.id==='retry-read').seq;
  await post(base,'/api/read',{code:sender.code,token:reader.token,msgIds:['retry-read']});

  const cursor={code:sender.code,token:sender.token,lastSeq:sequence,lastReceiptSeq:sequence,lastReadReceiptSeq:0};
  const first=await post(base,'/api/poll',cursor);
  const replay=await post(base,'/api/poll',cursor);
  assert.equal(first.readReceipts.find(receipt=>receipt.msgId==='retry-read')?.readAt > 0,true);
  assert.equal(replay.readReceipts.find(receipt=>receipt.msgId==='retry-read')?.readAt > 0,true,'same cursor must replay a response the device may have lost');

  const acknowledged=await post(base,'/api/poll',{...cursor,lastReadReceiptSeq:sequence});
  assert.equal(acknowledged.readReceipts.some(receipt=>receipt.msgId==='retry-read'),false);

  // An older shell may consume its compatibility one-shot flag. That must
  // never prevent a current second device from reading the same receipt.
  await post(base,'/api/poll',{code:sender.code,token:sender.token,lastSeq:sequence,lastReceiptSeq:sequence});
  const secondDevice=await post(base,'/api/poll',cursor);
  assert.equal(secondDevice.readReceipts.some(receipt=>receipt.msgId==='retry-read'),true);
});
