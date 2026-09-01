const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

test('encrypted call-history synchronization suppresses ordinary message pushes', () => {
  assert.match(
    client,
    /api\('\/api\/send', \{ code:room\.code, token:room\.token, content:encrypted, msgId:rec\.id, suppressNotification:true \}\)/
  );
  assert.match(server, /if \(d\.suppressNotification !== true\) for \(const \[t, mb\] of room\.members\)/);
});
