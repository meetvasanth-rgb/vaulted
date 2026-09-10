const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function readFunction(name, nextName) {
  const start = client.indexOf(`function ${name}(`);
  const end = client.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} should exist`);
  assert.notEqual(end, -1, `${nextName} should follow ${name}`);
  return client.slice(start, end).replace(/\basync\s*$/, '');
}

const context = {};
vm.createContext(context);
vm.runInContext(
  `${readFunction('unansweredCallEvent', 'addCallSysMsg')}\n` +
  `${readFunction('callEventForViewer', 'processIncomingContent')}`,
  context,
);

test('unanswered calls use a receiver-specific missed label', () => {
  const event = context.unansweredCallEvent('initiator');
  assert.equal(context.callEventForViewer(event, true).text, 'No answer');
  assert.equal(context.callEventForViewer(event, false).text, 'Missed encrypted call');
});

test('perspective remains correct when the receiver writes the shared event first', () => {
  const event = context.unansweredCallEvent('receiver');
  assert.equal(context.callEventForViewer(event, true).text, 'Missed encrypted call');
  assert.equal(context.callEventForViewer(event, false).text, 'No answer');
});

test('call history makes no-answer and missed-call records visible', () => {
  assert.match(client, /Encrypted call\|Missed\(\?: encrypted\)\? call\|No answer\|Call declined/);
  assert.match(client, /else if \(!isPerspectiveCallEvent \|\| rec\.callEventViewerRole === 'receiver'\) room\.unread\+\+/);
});
