const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');

function functionSource(name, nextName) {
  const start = client.indexOf(`function ${name}(`);
  const end = client.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} is missing`);
  assert.notEqual(end, -1, `${nextName} is missing`);
  return client.slice(start, end);
}

test('App Lock refocus waits for the active iOS scene and settles only once', () => {
  const timers = [];
  const classes = new Set(['quick-locked']);
  let focusCalls = 0;
  const input = { focus() { focusCalls += 1; context.document.activeElement = input; } };
  const context = vm.createContext({
    quickLockActive:true,
    quickLockUnlocking:false,
    nativeIOSCallOverAppLock:false,
    nativeIOSLifecycleKnown:true,
    nativeIOSAppActive:false,
    appLockFocusRequest:0,
    document:{
      hidden:true,
      activeElement:null,
      getElementById(id) {
        if (id === 'app-lock-passcode') return input;
        if (id === 'privacy-cover') return { classList:{ contains:value => classes.has(value) } };
        return null;
      },
    },
    setTimeout(fn, delay) { timers.push({ fn, delay }); },
  });
  vm.runInContext(`${functionSource('requestAppLockPasscodeFocus', 'renderQuickLock')}this.requestFocus=requestAppLockPasscodeFocus;`, context);

  context.requestFocus();
  timers.splice(0).forEach(timer => timer.fn());
  assert.equal(focusCalls, 0, 'inactive notification transition must not summon the keyboard behind the cover');

  context.nativeIOSAppActive = true;
  context.requestFocus();
  const activeTimers = timers.splice(0);
  assert.deepEqual(activeTimers.map(timer => timer.delay), [0, 80, 220, 500]);
  activeTimers.forEach(timer => timer.fn());
  assert.equal(focusCalls, 1, 'the passcode field should remain the single focused control');
});

test('foreground and notification-open paths both restore App Lock focus', () => {
  const resume = functionSource('resumeForegroundWork', 'playCallConnectedHaptic');
  assert.match(resume, /if \(quickLockActive\) \{[\s\S]*renderQuickLock\(\);[\s\S]*requestAppLockPasscodeFocus\(\);[\s\S]*return;/);

  const listenerStart = client.indexOf("plugin.addListener('pushNotificationActionPerformed'");
  const listenerEnd = client.indexOf('// Capacitor reports Android', listenerStart);
  const listener = client.slice(listenerStart, listenerEnd);
  assert.match(listener, /if \(quickLockActive\) requestAppLockPasscodeFocus\(\);/);
});

test('CallKit presentation never competes with the App Lock keyboard', () => {
  const focus = functionSource('requestAppLockPasscodeFocus', 'renderQuickLock');
  assert.match(focus, /nativeIOSCallOverAppLock\) return/);
});
