'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
const source=fs.readFileSync('server/index.js','utf8');
function harness(){
 let now=Date.parse('2026-11-28T08:02:00Z'),checks=0;
 const route=source.slice(source.indexOf("  if (path === '/api/account/login' && method === 'POST')"),source.indexOf("  if (path === '/api/account/change-password'"));
 const rateFunctions=source.slice(source.indexOf('async function rateLimited('),source.indexOf('async function profileLookupRetryAfter('));
 const ctx=vm.createContext({crypto,Map,Math,String,Date:{now:()=>now},rateLimitBuckets:new Map(),
  realtimeCoordinator:{rateLimited:async()=>null,refundRateLimit:async()=>null},normalizePrivateNumber:value=>String(value||'').replace(/[^0-9]/g,''),
  accountByPrivateNumber:number=>String(number).startsWith('9')?null:{accountId:String(number),account:{authVerifier:'real',revision:1}},DUMMY_ACCOUNT_VERIFIER:'dummy',
  verifyAccountSecret:async(secret)=>{checks++;return secret==='correct'},safetyStore:{isSuspended:async()=>false},
  replaceAccountLoginSession:async()=> 'fresh-session',accountDeviceHash:()=> 'device',loginLocation:()=>null,noteAccountClient(){},detectClientKind:()=>'',persistAccount:async()=>{},publicAccount:()=>({}),accountRetention:()=>null,
  resErr:(_,error,status)=>({error,status}),res200:(_,data)=>({status:200,...data})});
 vm.runInContext(rateFunctions+`\nasync function login(d, ip='office') { const path='/api/account/login',method='POST',headers={};const res={setHeader(){}};${route}}`,ctx);
 return {ctx,login:(privateNumber,authSecret='correct',ip)=>ctx.login({privateNumber,authSecret},ip),checks:()=>checks,advance:ms=>{now+=ms}};
}
test('successful sign-ins no longer exhaust a ten-attempt password-failure allowance',async()=>{const h=harness();for(let i=0;i<20;i++)assert.equal((await h.login('3375856378')).status,200);assert.equal(h.checks(),20)});
test('wrong passwords still lock the same number after ten checks, while another number on office Wi-Fi can sign in',async()=>{const h=harness();for(let i=0;i<10;i++)assert.equal((await h.login('3375856378','wrong')).status,403);assert.equal((await h.login('3375856378')).status,429);assert.equal(h.checks(),10);assert.equal((await h.login('4275856378')).status,200);h.advance(15*60*1000);assert.equal((await h.login('3375856378')).status,200)});
test('the coarse IP limit still bounds verification work across many different numbers',async()=>{const h=harness();for(let i=0;i<60;i++)await h.login(String(3300000000+i),'wrong');assert.equal((await h.login('3375856378')).status,429);assert.equal(h.checks(),60)});
test('unknown numbers still pay the dummy verification cost and return the same credential error',async()=>{const h=harness();assert.equal((await h.login('9375856378','wrong')).status,403);assert.equal(h.checks(),1);assert.equal((await h.login('3375856378','wrong')).error,(await h.login('9375856378','wrong')).error)});
test('concurrent failures cannot bypass the ten-slot reservation',async()=>{const h=harness();const results=await Promise.all(Array.from({length:11},()=>h.login('3375856378','wrong')));assert.equal(results.filter(r=>r.status===403).length,10);assert.equal(results.filter(r=>r.status===429).length,1);assert.equal(h.checks(),10)});
test('the obsolete shared counter does not block the new scoped allowance',async()=>{const h=harness();h.ctx.rateLimitBuckets.set('account-login:office',{count:20,windowStart:Date.now()});assert.equal((await h.login('3375856378')).status,200)});
test('reservation keys normalize the number, hide it, and remain separate across windows',()=>{const h=harness();vm.runInContext('keyForTest=accountLoginFailureKey',h.ctx);const key=h.ctx.keyForTest('office','33-7585-6378');assert.equal(key,h.ctx.keyForTest('office','3375856378'));assert.ok(!key.includes('3375856378'));h.advance(15*60*1000);assert.notEqual(h.ctx.keyForTest('office','3375856378'),key)});
test('Redis refunds use an atomic decrement without resetting failures or extending their expiry',async()=>{const {RealtimeCoordinator}=require('./realtime-coordinator');const c=new RealtimeCoordinator();assert.equal(await c.refundRateLimit('key'),null);c.ready=true;let call;c.publisher={eval:async(...args)=>{call=args;return 0}};assert.equal(await c.refundRateLimit('key'),true);assert.match(call[0],/DECR/);assert.doesNotMatch(call[0],/DEL|PEXPIRE|SET/);assert.equal(call[1].keys[0],c.rateKey('key'));c.publisher.eval=async()=>{throw Error('offline')};assert.equal(await c.refundRateLimit('key'),null)});
