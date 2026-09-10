const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client/index.html'), 'utf8');

test('native edge swipes provide back and app-home navigation', () => {
  assert.match(client, /const NATIVE_SWIPE_EDGE_PX = 28/);
  assert.match(client, /if \(!isNativeApp\(\)/);
  assert.match(client, /swipe\.edge === 'left' && dx > 0\) navigateBackFromNativeSwipe\(\)/);
  assert.match(client, /swipe\.edge === 'right' && dx < 0\) navigateHomeFromNativeSwipe\(\)/);
  assert.match(client, /case 's-chat': openVaultInbox\(\)/);
  assert.match(client, /loadAccountState\(\) \|\| rooms\.size > 0\) openVaultInbox\(\)/);
});

test('native swipes do not take over calls, overlays, or interactive content', () => {
  assert.match(client, /room\.callState && room\.callState !== 'idle'/);
  assert.match(client, /#conversation-menu\.open/);
  assert.match(client, /input, textarea, select, button, a/);
  assert.match(client, /Math\.abs\(dx\) < Math\.abs\(dy\) \* 1\.25/);
});
