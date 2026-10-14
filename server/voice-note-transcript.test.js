const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');
const groups = fs.readFileSync(path.join(root, 'client/groups.js'), 'utf8');
const android = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/MainActivity.java'), 'utf8');
const ios = fs.readFileSync(path.join(root, 'mobile/ios/App/App/SceneDelegate.swift'), 'utf8');
const androidOffline = fs.readFileSync(path.join(root, 'mobile/android/app/src/main/java/com/vaultlix/app/OfflineTranscriptEngine.java'), 'utf8');
const androidGradle = fs.readFileSync(path.join(root, 'mobile/android/app/build.gradle'), 'utf8');
const iosOffline = fs.readFileSync(path.join(root, 'mobile/ios/App/App/OfflineTranscriptEngine.swift'), 'utf8');
const iosPackage = fs.readFileSync(path.join(root, 'mobile/ios/App/CapApp-SPM/Package.swift'), 'utf8');

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

test('voice-note transcript language can be selected independently and is remembered locally', () => {
  assert.match(client, /id="transcript-language-select"/);
  assert.match(client, /VAULTLIX_TRANSCRIPT_LANGUAGE_KEY = 'vaultlix_transcript_language_v1'/);
  assert.match(client, /function currentTranscriptLocale\(\)/);
  assert.match(client, /localStorage\.setItem\(VAULTLIX_TRANSCRIPT_LANGUAGE_KEY/);
  assert.match(client, /const locale = currentTranscriptLocale\(\)/);
  assert.match(client, /transcribeVoiceNote\(requestId, pcmBase64, locale\)/);
  assert.match(client, /locale \}\);/);
});

test('Tamil transcripts can be displayed locally in familiar English letters', () => {
  assert.match(client, /id="transcript-script-select"/);
  assert.match(client, /VAULTLIX_TRANSCRIPT_SCRIPT_KEY = 'vaultlix_transcript_script_v1'/);
  assert.match(client, /function tamilToEnglishLetters\(value\)/);
  assert.match(client, /function formatVoiceTranscript\(text\)/);
  assert.match(client, /formatVoiceTranscript\(String\(detail\.text/);
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

test('Android requests microphone permission before transcribing saved voice notes and resumes after approval', () => {
  assert.match(android, /VOICE_TRANSCRIPT_PERMISSION_REQUEST = 75/);
  assert.match(android, /checkSelfPermission\(Manifest\.permission\.RECORD_AUDIO\) != PackageManager\.PERMISSION_GRANTED[\s\S]{0,500}VOICE_TRANSCRIPT_PERMISSION_REQUEST/);
  assert.match(android, /requestCode == VOICE_TRANSCRIPT_PERMISSION_REQUEST/);
  assert.match(android, /beginVoiceTranscript\(requestId, pcmFile, locale\)/);
  assert.match(android, /case SpeechRecognizer\.ERROR_INSUFFICIENT_PERMISSIONS:[\s\S]{0,160}Allow microphone access to create voice-note transcripts\./);
});

test('Android retries recognizer failures and sends unsupported languages directly to the multilingual model', () => {
  assert.match(android, /private void runVoiceTranscriptAttempt\(/);
  // Unsupported languages must never be mis-transcribed through an English recognizer.
  assert.match(android, /ERROR_LANGUAGE_NOT_SUPPORTED[\s\S]{0,200}ERROR_LANGUAGE_UNAVAILABLE/);
  assert.match(android, /if \(languageProblem\) \{[\s\S]{0,160}runOfflineVoiceTranscript\(requestId, locale, onDevice\)/);
  assert.doesNotMatch(android, /runVoiceTranscriptAttempt\(requestId, "en-US"/);
  assert.match(android, /runVoiceTranscriptAttempt\(requestId, locale, false, attempt \+ 2\)/);
  assert.doesNotMatch(android, /onDevice && attempt < 2 && !noSpeech/);
  assert.match(android, /voiceTranscriptErrorMessage\(error\)/);
  assert.match(android, /"Transcript failed \(code " \+ error \+ "\)\."/);
  assert.match(android, /\+ ",code:" \+ code/);
  // The saved PCM survives between attempts; only the final outcome deletes it.
  const release = android.slice(android.indexOf('private void releaseVoiceTranscriptRecognizer()'), android.indexOf('private void clearVoiceTranscript()'));
  assert.doesNotMatch(release, /voiceTranscriptFile/);
});

test('Android collects injected-audio segmented results used by Google speech services', () => {
  assert.match(android, /EXTRA_SEGMENTED_SESSION, RecognizerIntent\.EXTRA_AUDIO_SOURCE/);
  assert.match(android, /onSegmentResults\(Bundle segmentResults\)/);
  assert.match(android, /onEndOfSegmentedSession\(\)/);
  assert.match(android, /transcriptSegments\.add\(segment\)/);
  assert.match(android, /failOrRetry\(SpeechRecognizer\.ERROR_NO_MATCH\)/);
});

test('a silent decoded voice note is reported before anything is sent to the native recognizer', () => {
  assert.match(client, /if \(peak < 0\.004\) throw new Error\('silent-audio'\)/);
  assert.match(client, /silent \? 'No speech could be recognized\.'/);
});

test('the optional multilingual model is downloaded explicitly and its status is shown in language settings', () => {
  assert.match(client, /id="offline-transcript-model-status"/);
  assert.match(client, /id="offline-transcript-model-button"/);
  assert.match(client, /approximately 160 MB/i);
  assert.match(client, /never uploaded/i);
  assert.match(client, /action:'downloadOfflineTranscriptModel'/);
  assert.match(client, /vaultlix:offline-transcript-model/);
});

test('Android verifies and runs the pinned on-device multilingual model', () => {
  assert.match(androidGradle, /com\.github\.k2-fsa\.sherpa-onnx:sherpa-onnx:v1\.13\.8/);
  assert.match(androidOffline, /base-encoder\.int8\.onnx/);
  assert.match(androidOffline, /base-decoder\.int8\.onnx/);
  assert.match(androidOffline, /base-tokens\.txt/);
  assert.match(androidOffline, /new OfflineRecognizer\(null, config\)/);
  assert.match(androidOffline, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(androidOffline, /OfflineRecognizer/);
  assert.match(android, /runOfflineVoiceTranscript/);
  assert.match(android, /This language needs the offline multilingual model/);
});

test('iOS uses Apple speech first and falls back to the pinned on-device multilingual model', () => {
  assert.match(iosPackage, /sherpa-onnx\.git", exact: "1\.13\.8"/);
  assert.match(iosPackage, /product\(name: "sherpa-onnx", package: "sherpa-onnx"\)/);
  assert.match(iosOffline, /import SherpaOnnx/);
  assert.match(iosOffline, /SHA256\.hash/);
  assert.match(iosOffline, /SherpaOnnxOfflineRecognizer/);
  assert.match(ios, /runOfflineVoiceTranscript/);
  assert.match(ios, /action == "downloadOfflineTranscriptModel"/);
  assert.match(ios, /OfflineTranscriptEngine\.shared\.isReady/);
});
