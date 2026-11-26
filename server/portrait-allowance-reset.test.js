'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');

function usageHarness(offset) {
  const config = server.slice(server.indexOf('const DAILY_LOOK_RESET_OFFSET_MINUTES ='), server.indexOf('const DAILY_LOOK_CLAIM_TIMEOUT_MS'));
  const functions = server.slice(server.indexOf('function dailyLookDayWindow('), server.indexOf('// Bounded, exact receipt repair requests.'));
  const context = vm.createContext({ process:{ env:{ DAILY_LOOK_RESET_OFFSET_MINUTES:offset } }, DAY_MS:86400000, DAILY_LOOK_DAILY_LIMIT:15 });
  vm.runInContext(config + functions, context);
  return context;
}

test('yesterday’s eleven creations leave fifteen available at 6:30 AM IST', () => {
  for (const offset of [undefined, '', '  ', '330']) {
    const h = usageHarness(offset);
    const yesterday = Date.parse('2026-11-25T22:00:00+05:30');
    const account = { dailyLookWindowStartedAt:h.dailyLookDayWindow(yesterday).startedAt, dailyLookGenerationCount:11 };
    assert.equal(h.dailyLookUsage(account, yesterday).remaining, 4);
    assert.equal(h.dailyLookUsage(account, Date.parse('2026-11-26T06:30:00+05:30')).remaining, 15);
    const boundary = Date.parse('2026-11-26T00:00:00+05:30');
    assert.equal(h.dailyLookUsage(account, boundary - 1).remaining, 4);
    assert.equal(h.dailyLookUsage(account, boundary).remaining, 15);
  }
});

test('an explicit UTC override remains supported', () => {
  const h = usageHarness('0');
  const now = Date.parse('2026-11-26T06:30:00+05:30');
  assert.equal(h.dailyLookDayWindow(now).startedAt, Date.parse('2026-11-26T00:00:00Z'));
});

function screenHarness() {
  const status = { textContent:'4 of 15 portraits remaining today.' };
  const generate = { disabled:true };
  const callbacks = [];
  let visibleListener;
  let open = true;
  let calls = 0;
  const now = Date.parse('2026-11-26T01:00:00Z');
  const document = { hidden:false, getElementById:id => id === 'daily-look-status' ? status : id === 'daily-look-generate' ? generate : { classList:{ contains:() => open } }, addEventListener:(_, fn) => { visibleListener = fn; } };
  const context = vm.createContext({ document, Date:{ now:() => now }, window:{ clearTimeout:() => {}, setTimeout:(fn, delay) => { callbacks.push({fn,delay}); return callbacks.length; } }, loadAccountState:() => ({accountId:'account',sessionToken:'session'}), api:async () => { calls++; return {remaining:15,limit:15,available:true,configured:true,resetsAt:now+86400000}; }, dailyLookCreationTimer:null });
  const start = client.indexOf('let dailyLookAllowanceTimer =');
  vm.runInContext(client.slice(start, client.indexOf('async function openDailyLook(', start)), context);
  return {context,document,status,generate,callbacks,now,resume:() => visibleListener(),close:() => {open=false;},calls:() => calls};
}

test('an open studio refreshes the server allowance at midnight without rebuilding the photo picker', async () => {
  const h = screenHarness();
  h.context.scheduleDailyLookAllowanceRefresh(h.now - 1);
  assert.equal(h.callbacks[0].delay, 1000);
  await h.callbacks[0].fn();
  assert.equal(h.calls(), 1);
  assert.equal(h.status.textContent, '15 of 15 portraits remaining today.');
  assert.equal(h.generate.disabled, false);
});

test('returning from background after midnight refreshes the allowance', async () => {
  const h = screenHarness();
  h.context.scheduleDailyLookAllowanceRefresh(h.now - 1);
  h.document.hidden = true;
  await h.context.refreshDailyLookAllowance();
  assert.equal(h.calls(), 0);
  h.document.hidden = false;
  h.resume();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.status.textContent, '15 of 15 portraits remaining today.');
});

test('closed studios do not poll and active creations are allowed to finish', async () => {
  const h = screenHarness();
  h.context.dailyLookCreationTimer = 1;
  await h.context.refreshDailyLookAllowance();
  assert.equal(h.calls(), 0);
  assert.equal(h.callbacks[0].delay, 60000);
  h.close();
  h.context.dailyLookCreationTimer = null;
  await h.context.refreshDailyLookAllowance();
  assert.equal(h.calls(), 0);
});
