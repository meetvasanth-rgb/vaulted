'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const server = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client', 'index.html'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const manifest = fs.readFileSync(path.join(root, 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} should exist`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('capture pushes are generic and only sent after the peer is offline', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunction(server, 'shouldSendMessagePush')}\n${extractFunction(server, 'messageNotificationBody')}`, context);
  assert.equal(context.shouldSendMessagePush('screenshot', 95_000, 100_000), false);
  assert.equal(context.shouldSendMessagePush('screenshot', 92_000, 100_000), true);
  assert.equal(context.shouldSendMessagePush(null, 99_999, 100_000), true);
  assert.equal(context.messageNotificationBody('screenshot', 'Priya'), 'A screenshot was taken in your private conversation.');
  assert.equal(context.messageNotificationBody('screen-recording', 'Priya'), 'Screen recording started in your private conversation.');
  assert.doesNotMatch(context.messageNotificationBody('screenshot', 'Priya'), /Priya/);
});

test('capture events remain encrypted message content', () => {
  assert.match(client, /encryptMsg\(room, JSON\.stringify\(\{ type:'capture-event', event:type \}\)\)/);
  assert.match(client, /parsed\.type === 'capture-event'/);
  assert.match(server, /content: d\.content, viewOnce: !!d\.viewOnce, privacyEvent/);
});

test('native platforms emit only capture type and recording state', () => {
  assert.match(ios, /UIApplication\.userDidTakeScreenshotNotification/);
  assert.match(ios, /UIScreen\.capturedDidChangeNotification/);
  assert.doesNotMatch(ios, /UIImage|screenshotData|capturedImage/);
  assert.match(android, /registerScreenCaptureCallback/);
  assert.match(android, /addScreenRecordingCallback/);
  assert.match(manifest, /android\.permission\.DETECT_SCREEN_CAPTURE/);
  assert.match(manifest, /android\.permission\.DETECT_SCREEN_RECORDING/);
  assert.doesNotMatch(android, /MediaStore|Bitmap|ImageReader/);
});

test('the web bridge requires a visible conversation and deduplicates recording start', () => {
  assert.match(client, /!isRoomVisible\(room\) \|\| document\.hidden \|\| !tabFocused/);
  assert.match(client, /if \(active === nativeScreenRecordingActive\) return/);
  assert.match(client, /if \(document\.hidden\) nativeScreenRecordingActive = false/);
});
