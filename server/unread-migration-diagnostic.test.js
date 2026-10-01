'use strict';

// TEMPORARY — traces the Android legacy-unread migration (ad6fc5d..dab456b)
// for a device where a cleared/never-opened room's unread badge kept
// reappearing after a full reopen despite the migration appearing to run.
// Routed through a server endpoint (Railway logs) rather than a native
// Logcat bridge, since the production Android release WebView has no
// DevTools socket and a native bridge would need a new signed build before
// a single data point could come back. Remove this whole file alongside
// logUnreadMigrationDiagnostic() and the /api/debug-log route once the
// migration is confirmed fixed on the affected device.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
const client = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

function extract(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} missing`);
  const open = source.indexOf('{', source.indexOf(')', start));
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}

test('/api/debug-log hashes the room code with the same logCode() every other server log line uses, never logging it raw', () => {
  const start = server.indexOf("if (path === '/api/debug-log' && method === 'POST')");
  assert.notEqual(start, -1);
  const section = server.slice(start, start + 1400);
  assert.match(section, /logCode\(d\.code\.toLowerCase\(\)\.trim\(\)\)/);
  assert.doesNotMatch(section, /console\.log\([^)]*d\.code[^)]*\)/, 'the raw code must never reach console.log directly');
  assert.match(section, /rateLimited\(`debug-log:\$\{ip\}`, 30, 60 \* 1000\)/);
});

test('/api/debug-log only forwards a fixed whitelist of numeric/boolean/short-string fields into the log line', () => {
  const start = server.indexOf("if (path === '/api/debug-log' && method === 'POST')");
  const section = server.slice(start, start + 1400);
  assert.match(section, /for \(const key of \['event', 'storedVersion', 'pending', 'storedUnread', 'storedLastSeq', 'storedLastReadSeq',/);
  assert.match(section, /value\.slice\(0, 40\)/, 'strings are length-capped before logging');
});

test('logUnreadMigrationDiagnostic posts to /api/debug-log and never throws (fire-and-forget)', () => {
  const fn = extract(client, 'logUnreadMigrationDiagnostic');
  assert.match(fn, /api\('\/api\/debug-log', \{ code: room\.code, event:'unread_migration', \.\.\.fields \}\)\.catch\(\(\) => \{\}\);/);
});

test('persistRoomSeq now reports whether it actually wrote, instead of a bare early return', () => {
  const fn = extract(client, 'persistRoomSeq');
  assert.match(fn, /if \(!existing\) return false;/);
  assert.match(fn, /return true;/);
  assert.match(fn, /catch\(e\) \{ return false; \}/);
});

test('the /api/join path logs a before-snapshot UNCONDITIONALLY (not only when migration is pending), so a stale service-worker cache is distinguishable from "already migrated"', () => {
  const idx = client.indexOf('const unreadMigrationDiagBefore = {');
  assert.notEqual(idx, -1);
  const section = client.slice(idx, idx + 4700);
  assert.match(section, /logUnreadMigrationDiagnostic\(room, \{ \.\.\.unreadMigrationDiagBefore, joinSucceeded: !result\.error, returnedBaseline: result\.unreadBaselineSeq \}\);/);
  assert.match(section, /const persisted = persistRoomSeq\(room\);/);
  assert.match(section, /finalUnread: room\.unread, finalLastSeq: room\.lastSeq, finalLastReadSeq: room\.lastReadSeq,\s*\n\s*finalVersion: room\.unreadStateVersion, persisted,/);
});

test('the full-history-restore migration path also logs its own before/after snapshot, tagged separately from the join path', () => {
  const fnStart = client.indexOf('async function restoreRoomHistory(room)');
  assert.notEqual(fnStart, -1);
  const fnEnd = client.indexOf('\nasync function ', fnStart + 1);
  const fn = client.slice(fnStart, fnEnd);
  const idx = fn.indexOf("const restoreMigrationDiagBefore = room.unreadMigrationPending ? {");
  assert.notEqual(idx, -1);
  const section = fn.slice(idx);
  assert.match(section, /event:'full_restore'/);
  assert.match(section, /const restoreMigrationPersisted = persistRoomSeq\(room\);/);
  assert.match(section, /logUnreadMigrationDiagnostic\(room, \{\s*\n\s*\.\.\.restoreMigrationDiagBefore,/);
});
