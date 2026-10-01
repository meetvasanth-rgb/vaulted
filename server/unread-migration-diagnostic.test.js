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
  assert.match(section, /for \(const key of \['event', 'storedVersion', 'pending', 'storedUnread', 'storedUnreadSystemCount',/);
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

// ── The actual root cause, confirmed live on the affected OnePlus device:
// a never-opened room ("Victor") already carried unreadStateVersion:2 (so
// the one-time version-gated migration above correctly stays skipped) with
// lastReadSeq===lastSeq===7 — meaning by this room's own bookkeeping there
// is nothing outstanding — yet unread:4 anyway, evidently bumped by some
// live-arrival path sometime after the migration had already run once.
// Nothing re-derives a correct value from this state; zero is the only
// defensible one. Runs unconditionally on every launch (not version-gated,
// not one-time), so it keeps self-correcting regardless of what caused the
// drift, instead of relying on a single migration pass to get it exactly
// right forever. ──

test('a stale unread counter (lastReadSeq already caught up to lastSeq, but unread still nonzero) is zeroed on every launch, independent of the one-time migration', () => {
  const idx = client.indexOf('room.lastSeq = session.lastSeq || 0;');
  assert.notEqual(idx, -1);
  const section = client.slice(idx, idx + 1600);
  assert.match(section, /const staleUnreadSelfHealed = room\.lastReadSeq >= room\.lastSeq && \(room\.unread > 0 \|\| room\.unreadSystemCount > 0\);/);
  assert.match(section, /if \(staleUnreadSelfHealed\) \{\s*\n\s*room\.unread = 0;\s*\n\s*room\.unreadSystemCount = 0;\s*\n\s*persistRoomSeq\(room\);\s*\n\s*\}/);
  // Must run before the version-gated migration block (which only fires
  // when unreadMigrationPending is true) and before the diagnostic
  // snapshot (which reports the pre-heal value as storedUnread) — textual
  // ordering in this startup block is also execution ordering.
  const migrationIdx = client.indexOf('const unreadMigrationDiagBefore = {', idx);
  const selfHealIdx = client.indexOf('const staleUnreadSelfHealed =', idx);
  assert.ok(selfHealIdx > 0 && migrationIdx > selfHealIdx);
});

test('the diagnostic snapshot reports the PRE-heal unread value and whether self-healing fired, not the already-zeroed value', () => {
  const idx = client.indexOf('const unreadMigrationDiagBefore = {');
  assert.notEqual(idx, -1);
  const section = client.slice(idx, idx + 400);
  assert.match(section, /storedUnread: preHealUnread, storedUnreadSystemCount: preHealUnreadSystemCount,/);
  assert.match(section, /cutoffAt: room\.unreadMigrationCutoffAt, staleUnreadSelfHealed,/);
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
