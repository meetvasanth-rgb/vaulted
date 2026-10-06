const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');

test('received direct and group voice notes offer an on-demand transcript', () => {
  assert.match(client, /rec\.isMe \? '' : voiceTranscriptControlsHtml/);
  assert.match(client, /Show transcript/);
  assert.match(client, /html\.voice-transcript-ready \.voice-transcript-action\{display:block\}/);
  assert.match(client, /vaultlix:voice-transcript-capability/);
  assert.match(client, /requestDirectVoiceTranscript/);
  assert.match(groups, /message\.senderId === state\?\.accountId \? '' : voiceTranscriptControlsHtml/);
  assert.match(groups, /requestPrivateGroupVoiceTranscript/);
});

test('voice-note audio is decoded locally and transcript text is inserted safely', () => {
  const workflow = client.slice(client.indexOf('const voiceTranscriptStates'), client.indexOf('const voiceAudioEls'));
  assert.match(workflow, /OfflineAudioContext\(1, frames, sampleRate\)/);
  assert.match(workflow, /setInt16/);
  assert.match(workflow, /output\.textContent = state\.text \|\| state\.error/);
  assert.doesNotMatch(workflow, /api\(|\/api\//);
});

test('iOS transcribes the temporary PCM wave through the native speech recognizer', () => {
  assert.match(ios, /SFSpeechURLRecognitionRequest\(url: url\)/);
  assert.match(ios, /request\.requiresOnDeviceRecognition = onDevice/);
  assert.match(ios, /action == "transcribeVoiceNote"/);
  assert.match(ios, /vaultlix:voice-transcript/);
  assert.match(ios, /vaultlix:voice-transcript-capability/);
  assert.match(ios, /removeItem\(at: url\)/);
});

test('Android injects PCM audio on supported recognizers and removes the temporary file', () => {
  assert.match(android, /Build\.VERSION\.SDK_INT < Build\.VERSION_CODES\.TIRAMISU/);
  assert.match(android, /RecognizerIntent\.EXTRA_AUDIO_SOURCE, voiceTranscriptAudio/);
  assert.match(android, /RecognizerIntent\.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat\.ENCODING_PCM_16BIT/);
  assert.match(android, /public void transcribeVoiceNote\(/);
  assert.match(android, /public boolean supportsVoiceNoteTranscription\(\)/);
  assert.match(android, /voiceTranscriptFile\.delete\(\)/);
});

test('Android retries a failed transcript pass and reports the real recognizer error, not a blanket "no speech"', () => {
  assert.match(android, /private void runVoiceTranscriptAttempt\(/);
  // Language problems fall back to en-US; other on-device failures fall back to the system recognizer.
  assert.match(android, /ERROR_LANGUAGE_NOT_SUPPORTED[\s\S]{0,200}ERROR_LANGUAGE_UNAVAILABLE/);
  assert.match(android, /runVoiceTranscriptAttempt\(requestId, "en-US", onDevice, 1\)/);
  assert.match(android, /runVoiceTranscriptAttempt\(requestId, locale, false, attempt \+ 2\)/);
  assert.match(android, /voiceTranscriptErrorMessage\(error\)/);
  assert.match(android, /"Transcript failed \(code " \+ error \+ "\)\."/);
  assert.match(android, /\+ ",code:" \+ code/);
  // The saved PCM survives between attempts; only the final outcome deletes it.
  const release = android.slice(android.indexOf('private void releaseVoiceTranscriptRecognizer()'), android.indexOf('private void clearVoiceTranscript()'));
  assert.doesNotMatch(release, /voiceTranscriptFile/);
});

test('a silent decoded voice note is reported before anything is sent to the native recognizer', () => {
  assert.match(client, /if \(peak < 0\.004\) throw new Error\('silent-audio'\)/);
  assert.match(client, /silent \? 'No speech could be recognized\.'/);
});
