'use strict';

// On Android, Back from the call screen used to finish it while the call carried on unseen, with no
// way to reopen it (the activity was also hidden from Recents). The call screen now lives in its own
// task, steps aside on Back, and can be reopened from an ongoing notification or Recents.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main');
const manifest = fs.readFileSync(path.join(root, 'AndroidManifest.xml'), 'utf8');
const activity = fs.readFileSync(path.join(root, 'java', 'com', 'vaultlix', 'app', 'NativeCallActivity.java'), 'utf8');
const messaging = fs.readFileSync(path.join(root, 'java', 'com', 'vaultlix', 'app', 'VaultlixMessagingService.java'), 'utf8');

test('the call screen has its own task and is not hidden from Recents', () => {
  const declaration = manifest.slice(manifest.indexOf('android:name=".NativeCallActivity"'));
  const block = declaration.slice(0, declaration.indexOf('/>'));
  assert.match(block, /android:launchMode="singleTask"/);
  assert.match(block, /android:taskAffinity="com\.vaultlix\.app\.call"/);
  assert.doesNotMatch(block, /excludeFromRecents/);
});

test('Back and the back gesture minimise a live call instead of finishing it', () => {
  assert.match(activity, /registerOnBackInvokedCallback\(\s*OnBackInvokedDispatcher\.PRIORITY_DEFAULT,\s*\(OnBackInvokedCallback\) this::leaveCallScreen\)/);
  assert.match(activity, /@Override public void onBackPressed\(\) \{ leaveCallScreen\(\); \}/);
  const leave = activity.slice(activity.indexOf('private void leaveCallScreen()'), activity.indexOf('private void showOngoingCallNotification()'));
  assert.match(leave, /if \(finishingCall \|\| isFinishing\(\)\) \{ finish\(\); return; \}\s*moveTaskToBack\(true\);/);
});

test('an ongoing notification reopens the call while the screen is out of sight', () => {
  assert.match(activity, /if \(!finishingCall && !isFinishing\(\)\) showOngoingCallNotification\(\);\s*super\.onStop\(\);/);
  assert.match(activity, /super\.onStart\(\);\s*cancelOngoingCallNotification\(\);/);
  assert.match(activity, /running = false;\s*cancelOngoingCallNotification\(\);/);
  const post = activity.slice(activity.indexOf('private void showOngoingCallNotification()'), activity.indexOf('private void cancelOngoingCallNotification()'));
  assert.match(post, /Intent\.FLAG_ACTIVITY_NEW_TASK \| Intent\.FLAG_ACTIVITY_REORDER_TO_FRONT/);
  assert.match(post, /setOngoing\(true\)/);
  assert.match(post, /setUsesChronometer\(true\)/);
  assert.doesNotMatch(post, /CallStyle/, 'CallStyle needs a foreground service');
  // The incoming-call cleanup removes every notification on the call channels: this one must stay out of it.
  const prefix = messaging.match(/CALL_CHANNEL_PREFIX = "([^"]+)"/)[1];
  assert.ok(!activity.match(/ONGOING_CHANNEL_ID = "([^"]+)"/)[1].startsWith(prefix));
});

test('the ongoing-call strings exist in every shipped locale', () => {
  for (const dir of ['values', 'values-ar', 'values-hi', 'values-hy', 'values-ru', 'values-zh-rCN']) {
    const strings = fs.readFileSync(path.join(root, 'res', dir, 'strings.xml'), 'utf8');
    assert.match(strings, /<string name="ongoing_call_channel">[^<]+<\/string>/, dir);
    assert.match(strings, /<string name="ongoing_call_return">[^<]+<\/string>/, dir);
  }
});
