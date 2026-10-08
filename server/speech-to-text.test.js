const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');
const info = fs.readFileSync(path.join(root, 'mobile/ios/App/App/Info.plist'), 'utf8');

test('direct and group composers expose a distinct native voice-to-text action', () => {
  assert.match(client, /id="speech-to-text-btn"[^>]*toggleSpeechToText\('msg-input'\)/);
  assert.match(client, /id="group-speech-to-text-btn"[^>]*toggleSpeechToText\('group-message-input'\)/);
  assert.match(client, /html\.speech-to-text-ready \.speech-to-text-btn\{display:flex\}/);
  assert.match(client, /supportsNativeSpeechToText/);
  assert.match(client, /vaultlix:speech-to-text-capability/);
  assert.match(client, /\.chat-ftr\.has-text:not\(\.dictating\) \.speech-to-text-btn/);
  assert.match(client, /\.group-chat-footer\.has-text:not\(\.dictating\) \.speech-to-text-btn/);
});

test('recognized speech becomes an editable draft and is never auto-sent', () => {
  const workflow = client.slice(client.indexOf('let speechToTextDraft'), client.indexOf("window.addEventListener('vaultlix:speech-to-text-capability'"));
  assert.match(workflow, /input\.value = speechDraftValue/);
  assert.match(workflow, /input\.dispatchEvent\(new Event\('input'/);
  assert.doesNotMatch(workflow, /sendMsg\(|sendPrivateGroupMessage\(/);
  assert.match(client, /Review the text, then tap Send\./);
});

test('dictation keeps listening across a ten-second thinking pause', () => {
  assert.match(client, /const SPEECH_PAUSE_GRACE_MS = 10000/);
  assert.match(client, /function continueSpeechAfterPause\(draft = speechToTextDraft\)/);
  assert.match(client, /speechToTextDraft\.committed = joinSpeechPhrases/);
  assert.match(client, /startNativeSpeechSegment\(draft\)/);
  assert.match(client, /pauseDeadline > Date\.now\(\)/);
});

test('keyboard and speech drafts grow both composers up to their scroll cap', () => {
  assert.match(client, /function resizeChatComposer\(inputOrId\)/);
  assert.match(client, /input\.style\.height = 'auto'/);
  assert.match(client, /Math\.min\(input\.scrollHeight, maxHeight\)/);
  assert.match(client, /function onTyping\(\) \{\s*resizeChatComposer\('msg-input'\)/);
  const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
  assert.match(groups, /function updatePrivateGroupComposer\(\) \{[\s\S]*resizeChatComposer\(input\)/);
});

test('native composer sizing is scoped to the real platform marker', () => {
  assert.doesNotMatch(client, /@supports \(-webkit-touch-callout:none\)/);
  assert.match(client, /html\.vaultlix-native-ios #s-chat #msg-input\{font-size:17px!important\}/);
  assert.match(client, /html\.vaultlix-native-android #s-chat #msg-input:placeholder-shown\{[\s\S]{0,120}white-space:nowrap/);
  assert.match(client, /html\.vaultlix-native-android #s-chat \.mic-btn,[\s\S]{0,180}flex:0 0 38px!important/);
});

test('Android streams partial speech results through the existing trusted bridge', () => {
  assert.match(android, /SpeechRecognizer\.isRecognitionAvailable/);
  assert.match(android, /createOnDeviceSpeechRecognizer/);
  assert.match(android, /RecognizerIntent\.EXTRA_PARTIAL_RESULTS, true/);
  assert.match(android, /RecognizerIntent\.EXTRA_ENABLE_FORMATTING/);
  assert.match(android, /RecognizerIntent\.FORMATTING_OPTIMIZE_LATENCY/);
  assert.match(android, /EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 10000L/);
  assert.match(android, /EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 10000L/);
  assert.match(android, /void startSpeechToText\(String localeTag\)/);
  assert.match(android, /vaultlix:speech-to-text/);
});

test('iOS requests speech permission and returns partial on-device-capable results', () => {
  assert.match(ios, /import Speech/);
  assert.match(ios, /SFSpeechRecognizer\.requestAuthorization/);
  assert.match(ios, /request\.shouldReportPartialResults = true/);
  assert.match(ios, /request\.addsPunctuation = true/);
  assert.match(ios, /request\.requiresOnDeviceRecognition = onDevice/);
  assert.match(ios, /action == "startSpeechToText"/);
  assert.match(info, /<key>NSSpeechRecognitionUsageDescription<\/key>/);
});
