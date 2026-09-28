const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client/index.html'), 'utf8');

test('native horizontal swipes provide back and app-home navigation', () => {
  assert.match(client, /if \(!isNativeApp\(\)/);
  assert.match(client, /if \(window\.VaultlixAndroid\) return 'android'/);
  assert.doesNotMatch(client, /NATIVE_SWIPE_EDGE_PX/);
  assert.match(client, /if \(dx > 0\) navigateBackFromNativeSwipe\(\)/);
  assert.match(client, /else navigateHomeFromNativeSwipe\(\)/);
  assert.match(client, /case 's-chat': openVaultInbox\(\)/);
  assert.match(client, /window\.VaultlixAndroid\.goToDeviceHome\(\)/);
});

test('native swipes do not take over calls, overlays, or interactive content', () => {
  assert.match(client, /room\.callState && room\.callState !== 'idle'/);
  assert.match(client, /#conversation-menu\.open/);
  assert.match(client, /\.pdf-preview-overlay\.open, \.image-viewer-overlay/);
  assert.match(client, /overlay\.className = 'image-viewer-overlay'/);
  assert.match(client, /input, textarea, select, button, a/);
  assert.match(client, /Math\.abs\(dx\) < Math\.abs\(dy\) \* 1\.25/);
  // Composing a status (caption/audience picker) must not be interrupted by
  // an accidental back/home swipe underneath it.
  assert.match(client, /'\.pdf-preview-overlay\.open, \.image-viewer-overlay, #status-composer'/);
});

test('the status viewer answers the same native back/home swipe as every other screen', () => {
  // The viewer floats above whatever screen opened it, so it needs its own
  // check ahead of the screen-id switch, not a case inside it.
  assert.match(client, /if \(document\.getElementById\('status-viewer'\)\) \{ closeStatusViewer\(\); return; \}/);
  // The dedicated status list page IS a real screen, so it gets a case like
  // the chat screen already has — same "swipe back to inbox" behavior.
  assert.match(client, /case 's-status-page': openVaultInbox\(\); break;/);
  // Swiping home tears the viewer down too, so nothing is left floating
  // over whatever screen the home/fallback navigation lands on.
  assert.match(client, /function navigateHomeFromNativeSwipe\(\) \{\s*closeConversationMenu\(\);\s*closeSettings\(\);\s*closeStatusViewer\(\);/);
  // Horizontal drags inside the viewer no longer step prev/next themselves
  // (that competed with this same back/home swipe on the same axis) — only
  // the vertical dismiss-drag and the tap zones remain as local handling.
  const touchEnd = client.slice(client.indexOf('overlay.ontouchend = event => {', client.indexOf('function renderStatusViewer(')), client.indexOf('overlay.ontouchcancel'));
  assert.doesNotMatch(touchEnd, /statusViewerStep\(dx < 0 \? 1 : -1\)/);
  assert.match(touchEnd, /translateY\(100%\)/);
});
