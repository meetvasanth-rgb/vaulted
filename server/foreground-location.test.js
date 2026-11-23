'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
const source = client.slice(client.indexOf('let foregroundLocationAttempt = null;'), client.indexOf('function connectInbox()'));
function harness() {
  const calls = [];
  let now = 100000;
  let account = {accountId:'a', sessionToken:'secret'};
  const context = vm.createContext({
    document:{hidden:false}, quickLockActive:false,
    Date:{now:() => now}, loadAccountState:() => account,
    api:(route, data) => {calls.push({route,data}); return Promise.resolve({ok:true});},
  });
  vm.runInContext(source, context);
  return {context, calls, run:() => context.recordForegroundLocation(), advance:() => {now += 10001;}, signOut:() => {account = null;}};
}
test('foreground location is nonblocking, coalesced and not collected when hidden, locked or signed out', () => {
  const h = harness();
  h.context.document.hidden = true; h.run();
  h.context.document.hidden = false; h.context.quickLockActive = true; h.run();
  assert.equal(h.calls.length, 0);
  h.context.quickLockActive = false;
  assert.equal(h.run(), undefined, 'rendering does not await the location request');
  h.run(); h.run();
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].route, '/api/account/foreground');
  assert.deepEqual(Object.keys(h.calls[0].data).sort(), ['accountId','sessionToken']);
  h.advance(); h.run();
  assert.equal(h.calls.length, 2);
  h.signOut(); h.advance(); h.run();
  assert.equal(h.calls.length, 2);
});
test('network failures remain silent and allow a foreground retry', async () => {
  const h = harness();
  h.context.api = () => Promise.reject(Error('offline'));
  h.run();
  await new Promise(resolve => setImmediate(resolve));
  h.context.api = route => {h.calls.push({route}); return Promise.resolve({ok:true});};
  h.run();
  assert.equal(h.calls.length, 1);
});
test('initial inbox connection and foreground resume both update the last used location', () => {
  assert.match(client, /function connectInbox\(\) \{\s*recordForegroundLocation\(\);/);
  const resume = client.slice(client.indexOf('function resumeForegroundWork()'), client.indexOf("document.addEventListener('visibilitychange'", client.indexOf('function resumeForegroundWork()')));
  assert.match(resume, /if \(document.hidden \|\| quickLockActive\) return;\s*recordForegroundLocation\(\);/);
});
