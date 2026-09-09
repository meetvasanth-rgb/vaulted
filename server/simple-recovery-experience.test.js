const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const client = fs.readFileSync(path.join(__dirname, '..', 'client', 'index.html'), 'utf8');
const android = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'java', 'com', 'vaultlix', 'app', 'MainActivity.java'), 'utf8');
const androidManifest = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'android', 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
const ios = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'ios', 'App', 'App', 'SceneDelegate.swift'), 'utf8');

test('account creation enters the app without forcing recovery acknowledgement', () => {
  assert.match(client, /recoveryReminderDueAt:accountCreatedAt \+ RECOVERY_FIRST_REMINDER_MS/);
  assert.doesNotMatch(client, /document\.getElementById\('account-recovery-result'\)\.style\.display = ''/);
  assert.match(client, /if \(accountCreated\) await finishAccountCreation\(false\)/);
});

test('number-backup reminder starts after four hours and repeats daily', () => {
  assert.match(client, /RECOVERY_FIRST_REMINDER_MS = 4 \* 60 \* 60 \* 1000/);
  assert.match(client, /RECOVERY_REPEAT_REMINDER_MS = 24 \* 60 \* 60 \* 1000/);
  assert.match(client, /Save your recovery code/);
  assert.match(client, /View recovery code/);
  assert.match(client, /Remind me tomorrow/);
  assert.match(client, /if \(!document\.hidden\) checkRecoveryReminder\(\)/);
});

test('settings reduce recovery to the Private Number and recovery code', () => {
  assert.match(client, /<strong>Recovery code<\/strong>/);
  assert.match(client, /Private Number and recovery code are all you need/);
  assert.match(client, /private email, WhatsApp note or password manager/);
  assert.doesNotMatch(client, /Recover on a new phone|Copy another backup|account-save-recovery-form-wrap/);
  assert.match(client, /Share recovery details/);
  assert.match(client, /I’ve saved it/);
});

test('native wrappers authenticate before sensitive recovery details are revealed', () => {
  assert.match(client, /await requestNativeSensitiveAuthentication\(\)/);
  assert.match(android, /BiometricPrompt/);
  assert.match(android, /authenticateSensitiveAction/);
  assert.match(androidManifest, /android\.permission\.USE_BIOMETRIC/);
  assert.match(ios, /import LocalAuthentication/);
  assert.match(ios, /deviceOwnerAuthentication/);
  assert.match(ios, /vaultlix:device-auth-result/);
});

test('recovery card uses a private deep link and opens the prepared recovery form', () => {
  assert.match(client, /vaultlix:\/\/recover\/\$\{privateNumber\}#k=\$\{compact\}/);
  assert.match(client, /bytesToBase64UrlCompact\(recoveryCodeToBytes\(recoveryCode\)\)/);
  assert.match(client, /renderQrCanvas\(document\.getElementById\('recovery-backup-qr'\)/);
  assert.match(client, /function parseRecoveryLink/);
  assert.match(client, /openRecoveryFromLink\(startupRecovery\)/);
  assert.match(android, /"recover"\.equalsIgnoreCase\(uri\.getHost\(\)\)/);
  assert.match(ios, /url\.host\?\.lowercased\(\) == "recover"/);
});

test('recovery details use the instant system text share flow', () => {
  assert.match(client, /Keep these Vaultlix recovery details private/);
  assert.match(client, /if \(await openSystemShare\(text\)\) return/);
  assert.doesNotMatch(client, /PRIVATE NUMBER BACKUP/);
});
