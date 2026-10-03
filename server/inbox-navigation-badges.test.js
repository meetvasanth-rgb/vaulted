const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../client/index.html'), 'utf8');
function harness() {
  const storage = new Map();
  const nodes = new Map();
  for (const id of ['vault-nav-chats', 'vault-nav-calls', 'vault-nav-chats-badge', 'vault-nav-calls-badge']) {
    nodes.set(id, { hidden:true, setAttribute(key, value) { this[key] = value; } });
  }
  const state = { accountId:'a' };
  const context = vm.createContext({
    roomConcealed: () => false,
    rooms:new Map(), privateGroups:new Map(), entries:[], state,
    loadAccountState:() => state.accountId ? state : null,
    callHistoryEntries:() => context.entries,
    localStorage:{ getItem:k => storage.get(k), setItem:(k,v) => storage.set(k,v) },
    currentVaultListMode:'chats', tabFocused:true, quickLockActive:false, activePrivateGroupId:null,
    document:{ hidden:false, getElementById:id => id === 's-vault-list' ? {classList:{contains:() => true}} : nodes.get(id) },
  });
  vm.runInContext(html.slice(html.indexOf('let vaultMissedCallsSeenAccount'), html.indexOf('function setVaultListMode(mode)')), context);
  return { context, nodes, storage, state };
}
function missed(id, room='r') { return { room:{code:room}, rec:{id,callEventViewerRole:'receiver'}, text:'Missed encrypted call', occurredAt:123 }; }
test('navigation counts messages across rooms/groups without counting call alerts as messages', () => {
  const {context:c,nodes} = harness();
  c.rooms.set('r',{unread:5,unreadSystemCount:2}); c.rooms.set('s',{unread:2});
  c.privateGroups.set('g',{unread:4}); c.entries=[missed('1'),missed('1'),missed('2')];
  c.updateVaultNavigationBadges();
  assert.equal(nodes.get('vault-nav-chats-badge').textContent,'9');
  assert.equal(nodes.get('vault-nav-calls-badge').textContent,'2');
  assert.equal(nodes.get('vault-nav-chats')['aria-label'],'Show chats, 9 unread messages');
});
test('viewing calls acknowledges only missed incoming calls and leaves unread messages intact', () => {
  const {context:c,storage} = harness();
  c.rooms.set('r',{unread:3}); c.entries=[missed('1'),{...missed('2'),text:'No answer'}, {...missed('3'),rec:{id:'3',callEventViewerRole:'initiator'}}];
  assert.equal(c.vaultNavigationCounts().calls,1);
  c.markVaultMissedCallsViewed(); assert.equal(storage.size,0);
  c.currentVaultListMode='calls'; c.document.hidden=true; c.markVaultMissedCallsViewed(); assert.equal(storage.size,0);
  c.document.hidden=false; c.markVaultMissedCallsViewed();
  assert.equal(c.vaultNavigationCounts().calls,0); assert.equal(c.vaultNavigationCounts().messages,3);
  c.entries.push(missed('4')); assert.equal(c.vaultNavigationCounts().calls,1);
});
test('seen calls survive reload and never leak between accounts; zero hides badges and large counts cap visually', () => {
  const {context:c,state,nodes} = harness();
  c.entries=[missed('1')];c.currentVaultListMode='calls';c.markVaultMissedCallsViewed();
  state.accountId='b';assert.equal(c.vaultNavigationCounts().calls,1);
  state.accountId='a';assert.equal(c.vaultNavigationCounts().calls,0);
  c.rooms.set('r',{unread:120});c.updateVaultNavigationBadges();
  assert.equal(nodes.get('vault-nav-chats-badge').textContent,'99+');
  assert.equal(nodes.get('vault-nav-chats')['aria-label'],'Show chats, 120 unread messages');
  state.accountId=null;c.updateVaultNavigationBadges();
  assert.equal(nodes.get('vault-nav-chats-badge').hidden,true);
  assert.equal(nodes.get('vault-nav-calls-badge').hidden,true);
});
