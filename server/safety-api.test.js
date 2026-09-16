'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('node:net');
const { mkdtemp, rm } = require('node:fs/promises');
const { readFileSync } = require('node:fs');
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

async function post(base, pathname, body) {
  const response = await fetch(base + pathname, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify(body),
  });
  return { status:response.status, data:await response.json() };
}

test('Safety reports require account membership and consent; blocks prevent both directions', { timeout:15000 }, async t => {
  const port = await freePort();
  const snapshotDir = await mkdtemp(join(tmpdir(), 'vaultlix-quick-connect-test-'));
  const vapid = webpush.generateVAPIDKeys();
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd:join(__dirname, '..'),
    env:{ ...process.env, NODE_ENV:'test', ADMIN_KEY:'test-admin-safety-key', PORT:String(port), SNAPSHOT_DIR:snapshotDir, VAPID_PUBLIC_KEY:vapid.publicKey, VAPID_PRIVATE_KEY:vapid.privateKey },
    stdio:['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(snapshotDir, { recursive:true, force:true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('test server did not start')), 5000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes(`Vaultlix on port ${port}`)) { clearTimeout(timer); resolve(); }
    });
    child.once('exit', code => reject(new Error(`test server exited early (${code})`)));
  });

  const base = `http://127.0.0.1:${port}`;
  async function register(letter, privateNumber) {
    const result = await post(base, '/api/account/register', {
      accountId:letter.repeat(64), privateNumber, displayName:`User ${letter}`,
      authSecret:`auth-${letter}`.padEnd(48, letter), recoverySecret:`recovery-${letter}`.padEnd(48, letter),
      passwordWrap:'p'.repeat(24), recoveryWrap:'r'.repeat(24), bundle:'b'.repeat(24),
    });
    assert.equal(result.status, 200);
    return result.data;
  }
  const alice = await register('a', '2345678901');
  const bob = await register('b', '3456789012');
  const auth = account => ({ accountId:account.accountId, sessionToken:account.sessionToken });

  const stranger = await register('c','4567890123');
  const created = (await post(base,'/api/create',{name:'Bob',pubKey:'bob-key',persistent:true})).data;
  const joined = (await post(base,'/api/join',{name:'Alice',pubKey:'alice-key',code:created.code})).data;
  const request=await post(base,'/api/connections/request',{...auth(alice),privateNumber:'3456789012'});
  assert.equal((await post(base,'/api/connections/respond',{...auth(bob),requestId:request.data.requestId,action:'accepted',inviteUrl:`https://vaultlix.com/join/${created.code}#k=AAAAAAAAAAAAAAAAAAAAAA`})).status,200);
  const body={...auth(alice),code:created.code,token:joined.token,reason:'harassment',details:'Test report',messages:[{content:'Only with consent',isMe:false,ts:Date.now()}]};
  assert.equal((await post(base,'/api/report',{...body,...auth(stranger)})).status,403);
  assert.equal((await post(base,'/api/report',{...body,token:created.token})).status,403);
  const withoutConsent=await post(base,'/api/report',body);assert.equal(withoutConsent.status,200);
  const withConsent=await post(base,'/api/report',{...body,includeMessages:true});assert.equal(withConsent.status,200);
  assert.equal((await fetch(base+'/api/admin/safety')).status,404);
  const headers={Authorization:'Bearer test-admin-safety-key','Content-Type':'application/json'};
  let response=await fetch(base+'/api/admin/safety',{headers});
  assert.equal(response.headers.get('cache-control'),'no-store');
  const queue=(await response.json()).reports;
  assert.deepEqual(queue.find(r=>r.id===withoutConsent.data.reportId).messages,[]);
  const report=queue.find(r=>r.id===withConsent.data.reportId);
  assert.equal(report.messages[0].content,'Only with consent');
  assert.equal(report.reporterAccountId,undefined);assert.equal(report.roomCode,undefined);
  response=await fetch(base+'/api/admin/safety',{method:'POST',headers,body:JSON.stringify({id:report.id,status:'reviewing',note:'Checking evidence',expectedUpdatedAt:report.updatedAt})});
  assert.equal(response.status,200);
  response=await fetch(base+'/api/admin/safety',{method:'POST',headers,body:JSON.stringify({id:report.id,status:'resolved',note:'Stale update',expectedUpdatedAt:report.updatedAt})});
  assert.equal(response.status,409);
  assert.equal((await post(base,'/api/connections/block',body)).status,200);
  assert.equal((await post(base,'/api/connections/request',{...auth(alice),privateNumber:'3456789012',replaceExisting:true})).status,403);
  assert.equal((await post(base,'/api/connections/request',{...auth(bob),privateNumber:'2345678901',replaceExisting:true})).status,403);
  let latest=(await (await fetch(base+'/api/admin/safety',{headers})).json()).reports.find(r=>r.id===report.id);
  response=await fetch(base+'/api/admin/safety',{method:'POST',headers,body:JSON.stringify({id:latest.id,status:'resolved',note:'Synthetic suspension',expectedUpdatedAt:latest.updatedAt,accountAction:'suspend'})});
  assert.equal(response.status,200);
  assert.equal((await post(base,'/api/connections/request',{...auth(stranger),privateNumber:'3456789012'})).status,403);
  assert.equal((await post(base,'/api/connections/request',{...auth(bob),privateNumber:'4567890123'})).status,403);
  latest=(await (await fetch(base+'/api/admin/safety',{headers})).json()).reports.find(r=>r.id===report.id);
  assert.match(latest.history.at(-1).note,/Account: suspend/);
  response=await fetch(base+'/api/admin/safety',{method:'POST',headers,body:JSON.stringify({id:latest.id,status:'resolved',note:'Synthetic appeal accepted',expectedUpdatedAt:latest.updatedAt,accountAction:'restore'})});
  assert.equal(response.status,200);
  assert.equal((await post(base,'/api/connections/request',{...auth(stranger),privateNumber:'3456789012'})).status,200);

});
