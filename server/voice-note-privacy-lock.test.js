'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const appDelegate = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'AppDelegate.swift'), 'utf8');
const sceneDelegate = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');

function extractFunction(name) {
  const start = client.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = client.indexOf('{', client.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < client.length; i++) {
    if (client[i] === '{') depth++;
    else if (client[i] === '}' && --depth === 0) return client.slice(start, i + 1);
  }
  throw new Error('unbalanced function');
}

test('privacy lock destroys voice-note media and clears system playback state', () => {
  const nativeMessages = [];
  const icons = [];
  const graph = { context:{ closed:false, close() { this.closed = true; } } };
  const audio = {
    paused:false, src:'data:audio/mp4;base64,AAAA', loads:0,
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { this.loads++; },
  };
  const draftAudio = {
    paused:false, src:'blob:test', loads:0,
    pause() { this.paused = true; },
    removeAttribute(name) { if (name === 'src') this.src = ''; },
    load() { this.loads++; },
  };
  const mediaSession = { playbackState:'playing', metadata:{ title:'private note' }, setPositionState() { this.cleared = true; } };
  const context = vm.createContext({
    Map, Set, WeakMap,
    voiceAudioEls:new Map([['secret-voice', audio]]),
    voicePlaybackGraphs:new WeakMap([[audio, graph]]),
    voicePlaybackStarts:new Set(['secret-voice']),
    currentlyPlayingVoiceId:'secret-voice',
    voiceDraft:{ audio:draftAudio },
    navigator:{ mediaSession },
    window:{ webkit:{ messageHandlers:{ vaultlixCall:{ postMessage: message => nativeMessages.push(message) } } } },
    setVoicePlayIcon:(id, playing) => icons.push([id, playing]),
    setVoiceDraftPlayIcon:playing => icons.push(['draft', playing]),
    paintVoiceDraftProgress:ratio => { context.draftRatio = ratio; },
  });
  vm.runInContext(extractFunction('revokeVoiceNotePlayback'), context);
  vm.runInContext("revokeVoiceNotePlayback('hidden-chat-lock')", context);

  assert.equal(audio.paused, true);
  assert.equal(audio.src, '');
  assert.equal(audio.loads, 1);
  assert.equal(graph.context.closed, true);
  assert.equal(context.voiceAudioEls.size, 0);
  assert.equal(context.voicePlaybackStarts.size, 0);
  assert.equal(context.currentlyPlayingVoiceId, null);
  assert.equal(context.voiceDraft.audio, null);
  assert.equal(draftAudio.paused, true);
  assert.equal(mediaSession.playbackState, 'none');
  assert.equal(mediaSession.metadata, null);
  assert.equal(mediaSession.cleared, true);
  assert.equal(JSON.stringify(nativeMessages), JSON.stringify([{ action:'stopVoiceNotePlayback', reason:'hidden-chat-lock' }]));
  assert.deepEqual(icons, [['secret-voice', false], ['draft', false]]);
  assert.equal(context.draftRatio, 0);
});

test('every privacy transition revokes voice-note playback', () => {
  assert.match(client, /if \(!nativeIOSAppActive\) \{\s*revokeVoiceNotePlayback\('native-inactive'\);/);
  assert.match(client, /if \(isChatHidden\(activeRoomCode\).*revokeVoiceNotePlayback\('hidden-chat-lock'\);/);
  assert.match(client, /function activateAppLock[\s\S]*?renderQuickLock\(\);\s*revokeVoiceNotePlayback\('app-lock'\);/);
});

test('the iOS bridge clears Now Playing without interrupting a call', () => {
  assert.match(sceneDelegate, /if action == "stopVoiceNotePlayback"[\s\S]*VaultlixCallManager\.shared\.stopVoiceNotePlayback\(\)/);
  assert.match(appDelegate, /func stopVoiceNotePlayback\(\) \{\s*guard calls\.isEmpty else \{ return \}/);
  assert.match(appDelegate, /MPNowPlayingInfoCenter\.default\(\)\.playbackState = \.stopped/);
  assert.match(appDelegate, /MPNowPlayingInfoCenter\.default\(\)\.nowPlayingInfo = nil/);
  assert.match(appDelegate, /setActive\(false, options: \.notifyOthersOnDeactivation\)/);
});
