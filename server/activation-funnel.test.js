'use strict';

// The admin's sign-up funnel: how far new identities get. Counts only, from data the server already keeps.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { buildActivationFunnel, accountActivation, RETURN_AFTER_MS } = require('./activation-funnel');

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const account = (ageDays, extra = {}) => ({ createdAt:NOW - ageDays * DAY, lastActiveAt:NOW - ageDays * DAY, connectionRequests:[], pushDestinations:[], ...extra });
const request = (direction, status) => ({ id:`${direction}-${status}`, direction, status });
const cohort = (funnel, id) => funnel.cohorts.find(item => item.id === id);

test('each stage is counted from the account record, and shown against accounts old enough to judge', () => {
  const funnel = buildActivationFunnel([
    account(3),                                                                          // never came back
    account(3, { lastActiveAt:NOW - 1 * DAY }),                                          // came back, never asked
    account(4, { lastActiveAt:NOW, connectionRequests:[request('outgoing', 'pending')] }), // waiting
    account(5, { lastActiveAt:NOW, connectionRequests:[request('incoming', 'pending')] }), // got one, not answered
    account(6, { lastActiveAt:NOW, connectionRequests:[request('outgoing', 'accepted')], pushDestinations:[{}] }), // connected
    account(0.2),                                                                        // too new to judge
  ], NOW);
  const week = cohort(funnel, '7d');
  assert.equal(week.created, 6);
  assert.equal(week.newToday, 1);
  assert.equal(week.matured, 5);
  assert.equal(week.returned, 4);
  assert.equal(week.sentRequest, 2, 'a pending ask and an accepted one');
  assert.equal(week.connected, 1);
  assert.equal(week.notificationsOn, 1);
  assert.deepEqual(week.outcome, { connected:1, waitingForReply:1, receivedUnanswered:1, noRequestsButReturned:1, neverCameBack:1 });
});

test('the outcomes always add up to the accounts old enough to judge', () => {
  const accounts = Array.from({ length:50 }, (_, index) => account(1.5 + index * 0.4, {
    lastActiveAt:index % 3 ? NOW : 0,
    connectionRequests:index % 5 === 0 ? [request('outgoing', 'pending')] : index % 7 === 0 ? [request('incoming', 'accepted')] : [],
  }));
  const funnel = buildActivationFunnel(accounts, NOW);
  for (const item of funnel.cohorts) {
    const total = Object.values(item.outcome).reduce((sum, value) => sum + value, 0);
    assert.equal(total, item.matured, item.id);
    assert.ok(item.connected <= item.sentRequest || item.outcome.connected === item.connected);
  }
});

test('"came back" means active at least a day after joining', () => {
  assert.equal(accountActivation(account(5, { lastActiveAt:NOW - 5 * DAY + RETURN_AFTER_MS - 1 }), NOW).returned, false);
  assert.equal(accountActivation(account(5, { lastActiveAt:NOW - 5 * DAY + RETURN_AFTER_MS }), NOW).returned, true);
  assert.equal(accountActivation({ createdAt:NOW - 5 * DAY }, NOW).returned, false, 'never active at all');
});

test('being accepted counts as connected even for the person who never asked', () => {
  const entry = accountActivation(account(5, { connectionRequests:[request('incoming', 'accepted')] }), NOW);
  assert.equal(entry.connected, true);
  assert.equal(entry.sent, true, 'a connection implies the funnel step before it');
  assert.equal(entry.waitingForReply, false);
});

test('one-time invitation milestones are counted and marked test identities are excluded', () => {
  const activation = {
    inviteCreatedAt:NOW - 5 * DAY,
    inviteSharedAt:NOW - 5 * DAY + 1,
    inviteOpenedAt:NOW - 5 * DAY + 2,
    inviteRedeemedAt:NOW - 5 * DAY + 3,
    firstMessageAt:NOW - 5 * DAY + 4,
  };
  const funnel = buildActivationFunnel([
    account(5, { activation, acquisitionSource:'cafe-poster' }),
    account(5, { activation, isTestAccount:true, acquisitionSource:'internal-test' }),
  ], NOW);
  const all = cohort(funnel, 'all');
  assert.equal(funnel.excludedTestAccounts, 1);
  assert.deepEqual(funnel.sources, { 'cafe-poster':1 });
  assert.equal(all.created, 1);
  assert.equal(all.inviteCreated, 1);
  assert.equal(all.inviteShared, 1);
  assert.equal(all.inviteOpened, 1);
  assert.equal(all.inviteRedeemed, 1);
  assert.equal(all.firstMessage, 1);
});

test('cohorts are nested by age and accounts without a creation time are ignored', () => {
  const funnel = buildActivationFunnel([account(2), account(20), account(200), { displayName:'no date' }, null], NOW);
  assert.deepEqual(funnel.cohorts.map(item => [item.id, item.created]), [['7d', 1], ['30d', 2], ['all', 3]]);
  assert.deepEqual(buildActivationFunnel([], NOW).cohorts.map(item => item.created), [0, 0, 0]);
});

test('the funnel carries only counts: no names, numbers or identifiers', () => {
  const funnel = buildActivationFunnel([account(3, { displayName:'Secret Name', privateNumber:'2345678901', accountId:'f'.repeat(64) })], NOW);
  const text = JSON.stringify(funnel);
  assert.doesNotMatch(text, /Secret Name|2345678901|ffffffff/);
});

test('the admin stats include it, and the admin page renders it with text nodes only', () => {
  const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(server, /funnel: buildActivationFunnel\(accounts\.values\(\), now\),/);
  const adminJs = fs.readFileSync(path.join(__dirname, '..', 'client', 'admin.js'), 'utf8');
  const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'client', 'admin.html'), 'utf8');
  assert.match(adminJs, /renderFunnel\(s\.funnel\);/);
  assert.match(adminHtml, /id="funnel-table"/);
  const render = adminJs.slice(adminJs.indexOf('function renderFunnel'), adminJs.indexOf('function renderIdentities'));
  assert.doesNotMatch(render, /innerHTML/);

  // Run the real renderer against a tiny DOM.
  const nodes = [];
  const makeNode = tag => {
    const node = { tag, children:[], textContent:'', className:'', append(...kids) { this.children.push(...kids); }, appendChild(kid) { this.children.push(kid); return kid; }, replaceChildren(...kids) { this.children = kids; } };
    nodes.push(node);
    return node;
  };
  const table = makeNode('table');
  const context = vm.createContext({
    $: id => id === 'funnel-table' ? table : null,
    number: value => String(value || 0),
    document: { createElement: makeNode }, Math,
  });
  vm.runInContext(render, context);
  context.renderFunnel(buildActivationFunnel([account(3, { lastActiveAt:NOW, connectionRequests:[request('outgoing', 'accepted')] })], NOW));
  const [head, body] = table.children;
  assert.deepEqual(head.children[0].children.map(cell => cell.textContent), ['', 'Joined in the last 7 days', 'Joined in the last 30 days', 'Everyone']);
  const rows = body.children.map(row => row.children.map(cell => cell.textContent));
  assert.deepEqual(rows.find(row => row[0] === 'Connected with someone'), ['Connected with someone', '1 · 100%', '1 · 100%', '1 · 100%']);
  assert.deepEqual(rows.find(row => row[0] === 'Never came back'), ['Never came back', '0', '0', '0']);
});
