const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

test('call action stays available while transport becomes ready in background', () => {
  assert.match(client, /function canStartCall\(room\) \{\s*return !!room && room\.callState === 'idle' && !activeCallRoomCode;/);
  assert.match(client, /async function startCall\(\)[\s\S]*await waitForCallSignaling\(room\)/);
  assert.match(client, /androidNativeReady && !iosNativeReady && !\(await waitForCallSignaling/);
});
