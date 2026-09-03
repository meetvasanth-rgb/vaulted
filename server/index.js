const http = require('http');
const http2 = require('http2');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const webpush = require('web-push');
const { WebSocketServer } = require('ws');
const { initializeApp, cert } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const { PostgresStore } = require('./postgres');

const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
const PROCESS_STARTED_AT = Date.now();
const ADMIN_KEY = process.env.ADMIN_KEY || '';
if (ADMIN_KEY && ADMIN_KEY.length < 32) console.warn('ADMIN_KEY is shorter than 32 characters — replace it with a stronger key.');
// Named rooms are meant to persist for 4 days of inactivity, one-time
// (auto-generated code) rooms for 24 hours — per the product spec. This used
// to be a single flat 5-minute TTL for every room regardless of type, which
// silently deleted named rooms (and logged everyone out of them) within
// minutes of going idle. room.isNamed (set at creation) picks the right one.
const NAMED_ROOM_TTL = 4 * 24 * 60 * 60 * 1000;
const ONE_TIME_ROOM_TTL = process.env.NODE_ENV === 'test' && process.env.TEST_ONE_TIME_ROOM_TTL_MS
  ? Number(process.env.TEST_ONE_TIME_ROOM_TTL_MS)
  : 24 * 60 * 60 * 1000;
const ROOM_EXPIRY_SWEEP_MS = process.env.NODE_ENV === 'test' && process.env.TEST_ROOM_EXPIRY_SWEEP_MS
  ? Number(process.env.TEST_ROOM_EXPIRY_SWEEP_MS)
  : 30 * 1000;
const ADMIN_AUTH_WINDOW_MS = process.env.NODE_ENV === 'test' && process.env.TEST_ADMIN_AUTH_WINDOW_MS
  ? Number(process.env.TEST_ADMIN_AUTH_WINDOW_MS)
  : 10 * 60 * 1000;

const rooms = new Map();
const { markInviteTerminated, isInviteTerminated } = require('./call-invite-state');
const { buildTemporaryVaultAcceptedPayload } = require('./temporary-vault-notification');
const accounts = new Map();
const privateNumbers = new Map(); // public Vaultlix Private Number -> private random account id
const postgresStore = new PostgresStore(process.env.DATABASE_URL || '');
let postgresEnabled = false;
const CONNECTION_REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DELETION_TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── /api/send content sizing ─────────────────────────────────────────────
// These were measured against the client's actual code, not guessed. A
// file/GIF attachment never gets client-side compression (compressImageFile
// in client/index.html only touches non-GIF images; the generic "File"
// attach option never compresses anything), so a full MAX_FILE_SIZE (10MB,
// client/index.html) attachment is a real, legitimate send. That raw file
// goes through base64 -> JSON-wrap -> AES-GCM encrypt -> base64 AGAIN
// (encryptMsg in client/index.html), which measured out to ~17.78MB for a
// 10MB input — a naive "base64 inflates ~33%" estimate (~13.3MB) misses the
// second base64 layer encryptMsg adds and would reject real attachments. A
// full 5-minute voice note, measured from this app's actual MediaRecorder
// default bitrate (~129kbps, no explicit bitrate is ever set), came out far
// smaller (~8.17MB) and isn't the binding constraint.
const MAX_MESSAGE_CONTENT_BYTES = 19 * 1024 * 1024; // ~1.2MB headroom above the measured ~17.78MB ceiling

// A per-room budget can never bound total memory on its own — room
// creation is attacker-controlled (rate-limited, but not capped), so
// per-room x unbounded-rooms is still unbounded. The actual bound has to be
// GLOBAL, sized off what this container is actually allowed to use.
//
// os.totalmem() is deliberately NOT used here — inside a container it
// reports the HOST's total memory, not the cgroup limit this process is
// actually confined to, and would badly overestimate how much headroom
// really exists (a container capped at 512MB on a 64GB host would compute
// its budget as if it had 64GB to work with). Reading the cgroup limit
// directly is the only way to get the number that actually matters.
function getContainerMemoryLimit() {
  try { // cgroup v2
    const v = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    if (v && v !== 'max') return parseInt(v, 10);
  } catch (e) {}
  try { // cgroup v1
    const v = fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim();
    const n = parseInt(v, 10);
    if (n > 0 && n < 2 ** 53) return n; // v1 reports a huge sentinel value for "unlimited"
  } catch (e) {}
  return null;
}

// Conservative fixed fallback for when neither cgroup file is readable
// (non-Linux dev machine, a sandboxed environment without cgroups exposed,
// etc). Previously 128MB — raised after the baseline-subtraction formula
// below showed that 128MB minus FIXED_BASELINE (150MB) is NEGATIVE: a
// production server whose cgroup detection happens to fail would come up
// completely unusable (a zero/undefined budget) rather than merely
// degraded. 512MB keeps it functional — usable = 362MB, GLOBAL_BYTE_BUDGET
// = 144.8MB — at the cost of a smaller budget than a correctly-detected
// larger container would get. This is a "stay safe AND STAY WORKING when
// we can't see the real number" floor, not a target.
const FALLBACK_MEMORY_LIMIT = 512 * 1024 * 1024;

const detectedMemoryLimit = getContainerMemoryLimit();
if (detectedMemoryLimit === null) {
  console.warn(`Container memory limit could not be detected (no readable cgroup v1/v2 file) — falling back to a conservative ${FALLBACK_MEMORY_LIMIT / 1024 / 1024}MB assumption. Byte budgets below will be smaller than they could be on the real container size.`);
} else {
  console.log(`Detected container memory limit: ${detectedMemoryLimit} bytes (${(detectedMemoryLimit / 1024 / 1024).toFixed(1)}MB).`);
}
const EFFECTIVE_MEMORY_LIMIT = detectedMemoryLimit || FALLBACK_MEMORY_LIMIT;

// Baseline-subtraction, not a flat percentage of the raw limit — a flat
// percentage asks small containers to fund the SAME fixed cost (Node/V8's
// own baseline, connection buffers, GC bookkeeping, concurrent-request
// transients) out of an already-small remainder, when that fixed cost
// doesn't actually shrink just because the container is smaller. Subtract
// it first, THEN size the budget off whatever's actually left.
//
// FIXED_BASELINE covers:
//   - Node/V8's own baseline (loaded modules, ws/webpush, connection
//     buffers, GC bookkeeping).
//   - Concurrent-request transients: each in-flight /api/send holds
//     several copies of its own body at once while being processed — the
//     accumulated chunks array, the Buffer.concat result, the
//     .toString('utf8') conversion, and the JSON.parse'd content string —
//     roughly 4x that one request's size, bounded by BODY_LIMIT_SEND
//     (20MB) per request and by however many large sends land
//     concurrently. (Not client-side encryptMsg/decryptMsg — this server
//     never encrypts or decrypts anything, by E2E design; the real
//     server-side equivalent is this JSON.parse/JSON.stringify cycle.)
const FIXED_BASELINE = 150 * 1024 * 1024;
const usableMemory = EFFECTIVE_MEMORY_LIMIT - FIXED_BASELINE;

// V8 caps how long a single JS string can ever be — saveSnapshot's
// JSON.stringify builds ONE string containing every room's content, so
// this is a hard ceiling on GLOBAL_BYTE_BUDGET, not just a memory concern:
// a budget large enough to approach it makes that JSON.stringify call
// throw RangeError: Invalid string length at the worst possible moment
// (mid-shutdown), and the snapshot fails. Logged explicitly at boot so the
// actual value on whatever Node build this runs is on record, not assumed
// (512MB on some builds, 1GB on others).
const V8_STRING_CAP = require('buffer').constants.MAX_STRING_LENGTH;
console.log(`V8 MAX_STRING_LENGTH on this Node build (${process.version}): ${V8_STRING_CAP} bytes (${(V8_STRING_CAP / 1024 / 1024).toFixed(1)}MB).`);

// Flat ceiling independent of both container size and the V8 string cap —
// Railway bills on resource usage, so an oversized budget is a cost lever
// on its own even setting aside the crash risk above: something has to
// stop GLOBAL_BYTE_BUDGET from scaling up forever just because a bigger
// plan gets attached to this service later.
const HARD_CAP = 256 * 1024 * 1024;

// 2.5x covers the snapshot-time ~2.05x derived below, plus margin:
// saveSnapshot's JSON.stringify builds one big string containing every
// room's content on top of the still-live in-memory objects (nothing is
// freed until the synchronous call returns) — so snapshot time alone peaks
// around ~2x GLOBAL_BYTE_BUDGET, on top of GLOBAL_BYTE_BUDGET itself being
// "live" — call that ~2.05x total, and 2.5x leaves a bit of slack above it.
let GLOBAL_BYTE_BUDGET;
if (usableMemory <= 0) {
  // Not silently floored to something that "just works" — a container
  // this small genuinely cannot run this app safely at any budget, and
  // that's worth seeing at boot, not discovering later as "why did every
  // message just vanish."
  console.warn(`FIXED_BASELINE (${FIXED_BASELINE} bytes) alone exceeds the effective memory limit (${EFFECTIVE_MEMORY_LIMIT} bytes) — this container is too small to run this app at any budget. GLOBAL_BYTE_BUDGET is 0; every message will be evicted immediately after being accepted.`);
  GLOBAL_BYTE_BUDGET = 0;
} else {
  // Three independent ceilings, smallest wins — container memory is not
  // the only constraint. Named and logged individually so which one
  // actually bound the budget is visible in Railway logs, not something
  // that has to be re-derived from arithmetic after the fact.
  const candidates = [
    { name: 'container-memory-derived (usable / 2.5)', value: Math.floor(usableMemory / 2.5) },
    { name: 'V8-string-cap-derived (MAX_STRING_LENGTH * 0.5)', value: Math.floor(V8_STRING_CAP * 0.5) },
    { name: 'hard cap', value: HARD_CAP },
  ];
  let winner = candidates[0];
  for (const c of candidates) if (c.value < winner.value) winner = c;
  GLOBAL_BYTE_BUDGET = winner.value;
  console.log(`GLOBAL_BYTE_BUDGET candidates: ${candidates.map(c => `${c.name}=${c.value} bytes (${(c.value / 1024 / 1024).toFixed(1)}MB)`).join(', ')} — using ${winner.name} = ${GLOBAL_BYTE_BUDGET} bytes.`);
  // A container small enough that the computed budget can't hold one
  // legitimate max-size attachment (MAX_MESSAGE_CONTENT_BYTES, ~19MB)
  // means this app's large-attachment feature and this container's real
  // size are fundamentally in conflict — no formula resolves that, it
  // just needs a bigger container or a lower MAX_MESSAGE_CONTENT_BYTES.
  // Not silently floored/overridden here (that would risk exceeding the
  // real, detected limit instead) — just made loud, since it would
  // otherwise show up ONLY as "large sends mysteriously never arrive,"
  // discovered case-by-case in the wild.
  if (GLOBAL_BYTE_BUDGET < MAX_MESSAGE_CONTENT_BYTES) {
    console.warn(`GLOBAL_BYTE_BUDGET (${GLOBAL_BYTE_BUDGET} bytes) is SMALLER than MAX_MESSAGE_CONTENT_BYTES (${MAX_MESSAGE_CONTENT_BYTES} bytes) — a single max-size attachment can exceed the entire global budget and be evicted immediately after being accepted. This container is too small for this app's large-attachment feature as configured.`);
  }
}

// Fairness cap, not a memory bound (the global budget above is the actual
// bound) — stops any single room from consuming the whole global budget by
// itself and starving every other room. 25% of the global budget, i.e. at
// most 4 rooms could simultaneously sit at the fairness cap before the
// global bound would already have started evicting from whichever of them
// is largest.
//
// Floored at MAX_MESSAGE_CONTENT_BYTES — confirmed by testing that without
// this floor, a small enough global budget (25% of it landing under ~19MB)
// meant a single legitimate full-size attachment got accepted (200 OK,
// sender's own client renders it optimistically) and then evicted by THIS
// room's own fairness loop before the request handler even returned,
// milliseconds later — the recipient's next poll would never see it, with
// no error surfaced anywhere on either side. Raising this floor doesn't
// weaken the actual memory bound: GLOBAL_BYTE_BUDGET (and the warning
// above) is what that bound really is, and cross-room eviction there is
// unaffected by how high any one room's own fairness threshold sits.
const ROOM_BYTE_BUDGET = Math.max(Math.floor(GLOBAL_BYTE_BUDGET * 0.25), MAX_MESSAGE_CONTENT_BYTES);

console.log(`Byte budgets: global=${GLOBAL_BYTE_BUDGET} bytes (${(GLOBAL_BYTE_BUDGET / 1024 / 1024).toFixed(1)}MB), per-room fairness cap=${ROOM_BYTE_BUDGET} bytes (${(ROOM_BYTE_BUDGET / 1024 / 1024).toFixed(1)}MB).`);

// Even at zero messages, a room still costs real memory (a Map entry, two
// member records, ~20 scalar fields) — unbounded room COUNT is a separate
// DoS surface from unbounded room BYTES, and the byte budgets above do
// nothing to stop it. /api/create is already rate-limited per IP (8/10min),
// but that alone doesn't bound a distributed/many-IP campaign. 2000 is
// deliberately generous for this app's actual real-world scale (a niche
// anonymous 1:1 messenger, not a mass consumer app) while still being a
// hard, finite ceiling — at even a generous 10KB/room empty-state estimate,
// 2000 rooms is ~20MB, nowhere near the byte budgets above.
const MAX_CONCURRENT_ROOMS = 2000;

// Sum of every room's byteSize — the actual global memory bound tracked in
// real time, maintained everywhere room.byteSize is (pushRoomMsg,
// deleteRoomMsgContent, clear-chat's reset, destroyRoom below). A room's
// OWN byteSize existing without this would mean the fairness cap works but
// nothing actually enforces the global bound.
let totalByteSize = 0;

// Every room.msgs.push(...) site in this file must go through here instead
// of pushing directly. This is the fix for a real bug: /api/leave used to
// push its "X left" system message straight onto room.msgs with no trim of
// its own, relying entirely on /api/send happening to run the only count
// cap that existed anywhere — a push path that doesn't go through /api/send
// had nothing bounding its growth at all. Centralizing it here means a new
// push site can't quietly reintroduce that same unbounded-growth bug by
// forgetting to copy the trim logic along with it.
//
// room.byteSize/totalByteSize are running totals, updated here and in
// deleteRoomMsgContent/destroyRoom below, rather than recomputed by
// rescanning on every call (the previous trimRoomToByteBudget did exactly
// that — an O(n) scan on every single /api/send). Two separate eviction
// passes: first the per-room fairness cap (100 messages OR
// ROOM_BYTE_BUDGET bytes, whichever hits first, evicted from THIS room),
// then the global bound (GLOBAL_BYTE_BUDGET bytes total, evicted from
// whichever room is actually largest right now — not necessarily this one;
// the room being written to at this moment might be small while some OTHER
// room is the one actually hogging memory).
function pushRoomMsg(room, msg) {
  room.msgs.push(msg);
  const added = msg.content ? msg.content.length : 0;
  room.byteSize = (room.byteSize || 0) + added;
  totalByteSize += added;

  while (room.msgs.length > 100 || room.byteSize > ROOM_BYTE_BUDGET) {
    if (!room.msgs.length) break; // defensive — byteSize should already be 0 here too
    const removed = room.msgs.shift();
    const freed = removed.content ? removed.content.length : 0;
    room.byteSize -= freed;
    totalByteSize -= freed;
  }
  if (room.byteSize < 0) room.byteSize = 0; // defensive floor against any accounting drift

  while (totalByteSize > GLOBAL_BYTE_BUDGET) {
    let largest = null;
    for (const r of rooms.values()) {
      if (!r.msgs.length) continue;
      if (!largest || (r.byteSize || 0) > (largest.byteSize || 0)) largest = r;
    }
    if (!largest) break; // defensive — totalByteSize should already be 0 if nothing has content left
    const removed = largest.msgs.shift();
    const freed = removed.content ? removed.content.length : 0;
    largest.byteSize = Math.max(0, (largest.byteSize || 0) - freed);
    totalByteSize -= freed;
  }
  if (totalByteSize < 0) totalByteSize = 0;
}

// Shared by every place that nulls a message's content out from under it —
// the disappearing-message sweep below, /api/delete-message, and
// /api/view-once-opened — so room.byteSize AND totalByteSize stay in sync
// with what's actually still held in memory. Missing this in even one of
// those three call sites would leave both permanently overcounting real
// memory use (harmless to security, but it would make rooms evict other,
// still-live messages more aggressively than they need to) — centralized
// here for the same reason pushRoomMsg is: three separate call sites is
// three chances to forget one.
function deleteRoomMsgContent(room, msg) {
  if (msg.content) {
    const freed = msg.content.length;
    room.byteSize = Math.max(0, (room.byteSize || 0) - freed);
    totalByteSize = Math.max(0, totalByteSize - freed);
  }
  msg.content = null;
  msg.deleted = true;
  msg.deletionSeq = ++room.deletionSeq;
}

// Every room-deletion site must go through here instead of calling
// rooms.delete(...) directly — a destroyed room's bytes need to come back
// out of totalByteSize too, or the tracked global total would drift
// upward forever as rooms come and go, eventually making the global budget
// think it's full when the real rooms Map is mostly empty.
function destroyRoom(code) {
  const room = rooms.get(code);
  if (room) {
    totalByteSize = Math.max(0, totalByteSize - (room.byteSize || 0));
    publishInboxRoom(code, 'room-closed');
  }
  rooms.delete(code);
  // Closing/expiry must reach durable state immediately so a backup taken
  // before the next periodic pass cannot resurrect an already-erased vault.
  saveSnapshot({ log: false });
}

// VAPID keys identify this server to push services (Apple/Google/Mozilla's push
// endpoints) — they are NOT related to the E2E message encryption keys, and the
// server still never sees plaintext message content through this path (see the
// generic payload in /api/send below). Must come from environment variables
// only — no fallback. A hardcoded default here previously shipped a real
// private key in source, which must be treated as compromised. Failing fast
// (rather than silently disabling push) is deliberate: a silent degrade is
// exactly how a missing/misconfigured key goes unnoticed.
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
  console.error('VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set — refusing to start. Generate a keypair with `npx web-push generate-vapid-keys` and set both as Railway environment variables (and update the matching VAPID_PUBLIC_KEY constant in client/index.html).');
  process.exit(1);
}
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails('mailto:privacy@vaultlix.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Native iOS notifications are optional so the web app can still run before
// APNs is configured. TestFlight and App Store builds use production APNs.
// The .p8 private key must be supplied as an environment secret; it is never
// sent to the client or written to logs/snapshots.
const APNS_TEAM_ID = process.env.APNS_TEAM_ID || '';
const APNS_KEY_ID = process.env.APNS_KEY_ID || '';
const APNS_PRIVATE_KEY = (process.env.APNS_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'com.vaultlix.app';
const APNS_HOST = process.env.APNS_ENVIRONMENT === 'sandbox'
  ? 'https://api.sandbox.push.apple.com'
  : 'https://api.push.apple.com';
const APNS_CONFIGURED = !!(APNS_TEAM_ID && APNS_KEY_ID && APNS_PRIVATE_KEY);
if (!APNS_CONFIGURED) console.warn('Native iOS push is disabled: APNS_TEAM_ID, APNS_KEY_ID, and APNS_PRIVATE_KEY are not all set.');

// Native Android notifications use FCM. The service-account JSON is supplied
// as one Railway secret and never written to disk or exposed to the client.
// Keeping this optional lets the web and iOS transports continue operating
// while Android credentials are being provisioned, but logs the missing setup.
let firebaseMessaging = null;
try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '';
  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);
    firebaseMessaging = getMessaging(initializeApp({ credential: cert(serviceAccount) }));
  } else {
    console.warn('Native Android push is disabled: FIREBASE_SERVICE_ACCOUNT_JSON is not set.');
  }
} catch (e) {
  console.warn(`Native Android push is disabled: invalid Firebase credentials (${e.message}).`);
}

let apnsJwt = null;
let apnsJwtCreatedAt = 0;
function base64url(value) {
  return Buffer.from(value).toString('base64url');
}
function getApnsJwt() {
  const now = Math.floor(Date.now() / 1000);
  // Apple permits provider tokens for up to one hour; rotate at 50 minutes.
  if (apnsJwt && now - apnsJwtCreatedAt < 50 * 60) return apnsJwt;
  const header = base64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: APNS_PRIVATE_KEY,
    dsaEncoding: 'ieee-p1363',
  });
  apnsJwt = `${signingInput}.${base64url(signature)}`;
  apnsJwtCreatedAt = now;
  return apnsJwt;
}

function validateApnsToken(value) {
  // APNs currently returns a 32-byte token. Keep a conservative upper bound
  // so a future token-size change does not require weakening validation.
  return typeof value === 'string' && value.length >= 64 && value.length <= 200 && /^[a-fA-F0-9]+$/.test(value)
    ? value.toLowerCase()
    : null;
}

function sendApnsNotification(member, payload, ttlSeconds) {
  if (!APNS_CONFIGURED || !member.apnsToken) return Promise.resolve(false);
  let parsed;
  try { parsed = JSON.parse(payload); } catch (e) { return Promise.resolve(false); }
  const body = JSON.stringify({
    aps: {
      alert: { title: parsed.title || 'Vaultlix', body: parsed.body || 'New activity' },
      sound: 'default',
      'thread-id': parsed.code || 'vaultlix',
    },
    // No message text, encrypted payload, room credential, or member token is
    // included. `code` only lets an authenticated local session select the
    // correct already-open vault after a notification tap.
    code: parsed.code || '',
    isCall: !!parsed.isCall,
    isCallEnd: !!parsed.isCallEnd,
    missedCall: !!parsed.missedCall,
    caller: parsed.caller || '',
    callId: parsed.callId || '',
    msgId: parsed.msgId || '',
    connectionRequest: !!parsed.connectionRequest,
  });
  return new Promise((resolve) => {
    let client;
    const host = member.apnsEnvironment === 'sandbox'
      ? 'https://api.sandbox.push.apple.com'
      : APNS_HOST;
    try { client = http2.connect(host); } catch (e) { resolve(false); return; }
    const finish = (ok) => { try { client.close(); } catch (e) {} resolve(ok); };
    client.setTimeout(10000, () => { try { client.destroy(); } catch (e) {} resolve(false); });
    client.on('error', () => finish(false));
    let req;
    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${member.apnsToken}`,
        authorization: `bearer ${getApnsJwt()}`,
        'apns-topic': APNS_BUNDLE_ID,
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'apns-expiration': String(Math.floor(Date.now() / 1000) + Math.max(0, ttlSeconds || 0)),
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
    } catch (e) { finish(false); return; }
    let status = 0;
    let responseBody = '';
    req.on('response', headers => { status = Number(headers[':status'] || 0); });
    req.on('data', chunk => { if (responseBody.length < 2048) responseBody += chunk.toString(); });
    req.on('end', () => {
      let reason = '';
      try { reason = JSON.parse(responseBody).reason || ''; } catch (e) {}
      if (status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered' || reason === 'DeviceTokenNotForTopic') {
        member.apnsToken = null;
      } else if (status < 200 || status >= 300) {
        console.warn(`APNs send failed: status=${status || 'unknown'} reason=${reason || 'unknown'}`);
      }
      finish(status >= 200 && status < 300);
    });
    req.on('error', () => finish(false));
    req.end(body);
  });
}

function validateFcmToken(value) {
  return typeof value === 'string' && value.length >= 20 && value.length <= 4096 && /^[A-Za-z0-9_:\-.]+$/.test(value)
    ? value
    : null;
}

async function sendFcmNotification(member, payload, ttlSeconds) {
  if (!firebaseMessaging || !member.fcmToken) return false;
  let parsed;
  try { parsed = JSON.parse(payload); } catch (e) { return false; }
  try {
    const message = {
      token: member.fcmToken,
      data: {
        code: String(parsed.code || ''),
        isCall: parsed.isCall ? 'true' : 'false',
        isCallEnd: parsed.isCallEnd ? 'true' : 'false',
        missedCall: parsed.missedCall ? 'true' : 'false',
        caller: String(parsed.caller || ''),
        callId: String(parsed.callId || ''),
        msgId: String(parsed.msgId || ''),
        connectionRequest: parsed.connectionRequest ? 'true' : 'false',
        title: String(parsed.title || 'Vaultlix'),
        body: String(parsed.body || 'New activity'),
      },
      android: {
        priority: 'high',
        ttl: Math.max(0, Number(ttlSeconds) || 0) * 1000,
      },
    };
    // Calls are data-only so Android can build a native full-screen incoming
    // call notification. Ordinary messages remain system-rendered alerts.
    if (!parsed.isCall && !parsed.isCallEnd) {
      message.notification = {
        title: parsed.title || 'Vaultlix',
        body: parsed.body || 'New activity',
      };
      message.android.notification = {
        channelId: 'vaultlix_messages_system',
        icon: 'ic_stat_vaultlix',
        color: '#682C43',
        sound: 'default',
      };
    }
    await firebaseMessaging.send(message);
    return true;
  } catch (e) {
    if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
      member.fcmToken = null;
    } else {
      console.warn(`FCM send failed: ${e.code || e.message}`);
    }
    return false;
  }
}

function hasPushDestination(member) {
  return !!(member && (member.pushSub || member.apnsToken || member.fcmToken));
}

function sendMemberPush(member, payload, { urgency = 'high', TTL = 60, label = 'push' } = {}) {
  const hasNativeDestination = !!(member && (member.apnsToken || member.fcmToken));
  // A synced vault credential can carry the same room member token from a
  // browser/PWA into the native app. In that case the server may still have
  // the older Web Push subscription as well as the newer APNs/FCM token.
  // Sending down both channels produces two OS alerts for one message on the
  // same phone. Native delivery is authoritative whenever it is registered;
  // Web Push remains the fallback for browser-only members.
  if (member.pushSub && !hasNativeDestination) {
    webpush.sendNotification(member.pushSub, payload, { urgency, TTL, timeout: PUSH_TIMEOUT_MS }).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) member.pushSub = null;
      else console.warn(`${label} web push failed:`, err.statusCode, err.body || err.message);
    });
  }
  sendApnsNotification(member, payload, TTL).catch(() => {});
  sendFcmNotification(member, payload, TTL).catch(() => {});
}

function validateVoipToken(value) {
  return typeof value === 'string' && /^[a-f0-9]{64,200}$/i.test(value);
}

// VoIP tokens use a separate APNs topic and gateway from ordinary alert
// tokens. The environment is recorded by the signed native build that
// produced the token (debug = sandbox, TestFlight/App Store = production).
function sendVoipPush(member, payload) {
  if (!APNS_CONFIGURED || !member || !validateVoipToken(member.voipToken)) return Promise.resolve(false);
  const host = member.voipEnvironment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  return new Promise(resolve => {
    let client;
    try { client = http2.connect(host); } catch (e) { resolve(false); return; }
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (e) {}
      resolve(ok);
    };
    client.setTimeout(10000, () => finish(false));
    client.on('error', () => finish(false));
    let req;
    try {
      req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${member.voipToken}`,
        authorization: `bearer ${getApnsJwt()}`,
        'apns-topic': `${APNS_BUNDLE_ID}.voip`,
        'apns-push-type': 'voip',
        'apns-priority': '10',
        'apns-expiration': '0',
      });
    } catch (e) { finish(false); return; }
    req.setEncoding('utf8');
    let status = 0;
    let responseBody = '';
    req.on('response', headers => { status = Number(headers[':status'] || 0); });
    req.on('data', chunk => { if (responseBody.length < 1024) responseBody += chunk; });
    req.on('end', () => {
      if (status === 200) {
        console.log(`VoIP push accepted by APNs (${member.voipEnvironment || 'production'}).`);
        finish(true);
        return;
      }
      if ((status === 400 || status === 410) && /BadDeviceToken|Unregistered/.test(responseBody)) member.voipToken = null;
      let reason = 'unknown';
      try { reason = JSON.parse(responseBody).reason || reason; } catch (e) {}
      console.warn(`VoIP push rejected by APNs (status ${status || 'unknown'}, reason ${reason}).`);
      finish(false);
    });
    req.on('error', () => finish(false));
    req.end(JSON.stringify(payload));
  });
}

// Remote hang-up is deliberately a normal background APNs notification,
// never a PushKit notification. Apple requires every VoIP push to report a
// new incoming CallKit call and terminates apps that use it for call cleanup.
function sendNativeCallEnd(member, callId) {
  if (!APNS_CONFIGURED || !member || !member.apnsToken || !callId) return Promise.resolve(false);
  const host = member.apnsEnvironment === 'sandbox'
    ? 'https://api.sandbox.push.apple.com'
    : 'https://api.push.apple.com';
  // This is an ordinary background APNs notification, so use the action
  // consumed by UIApplication's remote-notification callback. Current iOS
  // builds accept both spellings to remain compatible during rolling deploys.
  const body = JSON.stringify({ aps: { 'content-available': 1 }, action: 'endCall', callId });
  return new Promise(resolve => {
    let client;
    try { client = http2.connect(host); } catch (e) { resolve(false); return; }
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch (e) {}
      resolve(ok);
    };
    client.setTimeout(10000, () => finish(false));
    client.on('error', () => finish(false));
    let req;
    try {
      req = client.request({
        ':method': 'POST', ':path': `/3/device/${member.apnsToken}`,
        authorization: `bearer ${getApnsJwt()}`,
        'apns-topic': APNS_BUNDLE_ID,
        'apns-push-type': 'background', 'apns-priority': '5', 'apns-expiration': '0',
      });
    } catch (e) { finish(false); return; }
    let status = 0;
    req.on('response', headers => { status = Number(headers[':status'] || 0); });
    req.on('data', () => {});
    req.on('end', () => finish(status >= 200 && status < 300));
    req.on('error', () => finish(false));
    req.end(body);
  });
}

// Math.random() is not a CSPRNG — predictable enough in theory that it has
// no business generating anything used as a credential. This is used for
// room auth tokens (the bearer credential behind every /api/poll, /api/send,
// /api/read call for a room) and message ids, so it needs real randomness.
function uid() { return crypto.randomBytes(16).toString('hex'); }

// Random per-boot key for pseudonymizing room codes in our own console logs
// (not persisted, not derived from anything — regenerated on every process
// start). An HMAC keyed by this lets log lines about the same room be
// correlated with each other within a single run, which is all debugging
// ever needs, while making a retained/leaked log archive from a past run
// useless for recovering the real codes: the key that produced those
// pseudonyms died with the process that generated it.
const LOG_PSEUDONYM_KEY = crypto.randomBytes(32);
function logCode(roomCode) {
  return crypto.createHmac('sha256', LOG_PSEUDONYM_KEY).update(roomCode).digest('hex').slice(0, 8);
}

// Room passwords are hashed with scrypt (memory-hard, built into Node's core
// crypto module — no new dependency) plus a random per-room salt, rather
// than stored and compared as a plain string. Stored as "saltHex:hashHex" in
// a single field so there's nothing extra to persist or migrate.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return salt.toString('hex') + ':' + hash.toString('hex');
}

// Constant-time comparison (crypto.timingSafeEqual) instead of !== so a
// response-timing difference can't be used to infer the password character
// by character. Returns true if no password was ever set on the room.
async function verifyPassword(attempt, stored) {
  if (!stored) return true;
  const [saltHex, hashHex] = stored.split(':');
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(attempt || '', salt, 64);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Fixed, per-boot-random salt burned only to match a real password check's
// scrypt cost when a /api/join room doesn't exist at all — see its dummy
// derivation call below. Never compared against anything; the sole purpose
// is making "no such vault" and "vault exists, wrong password" take the
// same wall-clock time, since scrypt is deliberately slow and a nonexistent
// room previously returned before ever touching it — a difference easily
// measurable over the network, and a cleaner oracle than the status code
// or message ever was.
const DUMMY_JOIN_SCRYPT_SALT = crypto.randomBytes(16);
async function dummyPasswordDerivation() {
  await scryptAsync('dummy-not-a-real-password', DUMMY_JOIN_SCRYPT_SALT, 64);
}

// ── RATE LIMITING ────────────────────────────────────────────────────────
// Simple in-memory fixed-window counters — same "nothing persisted beyond
// process memory" posture as everything else here, no external store. Not
// meant to stop a genuinely distributed attack (that's a job for a CDN/WAF
// in front of this, not application code); this exists purely because
// today there is NO limit at all on either room creation or message
// sending — a single script could spam-create rooms or flood one room with
// messages with nothing in the way.
const rateLimitBuckets = new Map(); // key -> { count, windowStart }

function rateLimited(key, maxCount, windowMs) {
  const now = Date.now();
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || now - bucket.windowStart >= windowMs) {
    rateLimitBuckets.set(key, { count: 1, windowStart: now });
    return false;
  }
  bucket.count++;
  return bucket.count > maxCount;
}

// Check an existing failure bucket without incrementing it. Admin auth uses
// this before comparing credentials so a correct guess cannot bypass the
// lockout after the failure budget has already been exhausted.
function isRateLimited(key, maxCount, windowMs) {
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || Date.now() - bucket.windowStart >= windowMs) return false;
  return bucket.count >= maxCount;
}

// Anonymous account authentication uses client-derived random-looking
// secrets, never the password or recovery code themselves.  Hash them again
// with server-side scrypt before persistence so a stolen accounts file does
// not contain bearer-equivalent login material.
async function hashAccountSecret(secret) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{40,96}$/.test(secret)) throw new Error('invalid account secret');
  return hashPassword(secret);
}
const DUMMY_ACCOUNT_SALT = crypto.randomBytes(16);
const DUMMY_ACCOUNT_VERIFIER = DUMMY_ACCOUNT_SALT.toString('hex') + ':' +
  crypto.scryptSync('not-a-real-account-secret', DUMMY_ACCOUNT_SALT, 64).toString('hex');
async function verifyAccountSecret(secret, verifier) {
  if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{40,96}$/.test(secret)) return false;
  return verifyPassword(secret, verifier);
}
function validAccountId(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function validAccountSecret(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{40,96}$/.test(value); }
function validEncryptedField(value, max) { return typeof value === 'string' && value.length >= 20 && value.length <= max; }
function normalizePrivateNumber(value) {
  const privateNumber = String(value || '').replace(/\D/g, '');
  return /^[2-9][0-9]{9}$/.test(privateNumber) ? privateNumber : '';
}
function generatePrivateNumber() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = crypto.randomBytes(10);
    let privateNumber = String(2 + (bytes[0] % 8));
    for (let i = 1; i < bytes.length; i++) privateNumber += String(bytes[i] % 10);
    if (!privateNumbers.has(privateNumber)) return privateNumber;
  }
  throw new Error('Could not allocate a Vaultlix Private Number');
}
function normalizeDisplayName(value) {
  const displayName = String(value || '').trim().replace(/\s+/g, ' ');
  return displayName.length >= 2 && displayName.length <= 40 && !/[<>\u0000-\u001f]/.test(displayName) ? displayName : '';
}
function accountByPrivateNumber(value) {
  const privateNumber = normalizePrivateNumber(value);
  const accountId = privateNumber ? privateNumbers.get(privateNumber) : null;
  return accountId ? { accountId, account:accounts.get(accountId) } : null;
}
function publicAccount(account) {
  return { privateNumber:account.privateNumber, displayName:account.displayName, address:`https://vaultlix.com/${account.privateNumber}` };
}
function newAccountSession(account) {
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  account.sessions = (account.sessions || []).filter(s => s.expiresAt > now).slice(-4);
  account.sessions.push({ tokenHash, createdAt: now, expiresAt: now + 30 * 24 * 60 * 60 * 1000 });
  return token;
}
function authenticateAccountSession(accountId, token) {
  const account = accounts.get(accountId);
  if (!account || typeof token !== 'string' || token.length > 128) return null;
  const actual = crypto.createHash('sha256').update(token).digest();
  const now = Date.now();
  account.sessions = (account.sessions || []).filter(s => s.expiresAt > now);
  for (const session of account.sessions) {
    const expected = Buffer.from(session.tokenHash, 'hex');
    if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return account;
  }
  return null;
}

async function persistAccount(accountId) {
  const account = accounts.get(accountId);
  if (!account) return;
  if (postgresEnabled) await postgresStore.saveAccount(accountId, account);
  else saveAccounts();
}

// Sweep stale buckets periodically so IPs/tokens that stopped being active
// don't sit in memory forever — mirrors the room-expiry sweep further down.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateLimitBuckets) {
    if (now - bucket.windowStart > 10 * 60 * 1000) rateLimitBuckets.delete(key);
  }
}, 5 * 60 * 1000);

// Railway's edge terminates TLS and proxies to this process, so
// req.socket.remoteAddress is Railway's own edge, not the visitor — the
// real client IP arrives via x-forwarded-for (same header already trusted
// above for the http->https redirect logic). Falls back to the socket
// address for local/direct-connection testing where that header is absent.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return xff.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

// web-push (the library actually used below) POSTs directly to
// subscription.endpoint — an unvalidated subscription object from any room
// member (trivial to become one: just create a room) let this server be
// made to issue arbitrary outbound POST requests, including to
// internal/metadata addresses (SSRF). This allowlist was checked against
// the real push-service ecosystem, not assumed:
//   - fcm.googleapis.com/android.googleapis.com — Google FCM (Chrome and
//     every other Chromium-family browser: Edge on Android, Opera, Brave);
//     both hostnames are referenced directly in this app's own web-push
//     dependency (node_modules/web-push/src/web-push-lib.js), which
//     special-cases them for legacy GCM auth.
//   - *.push.apple.com — Safari's own push service (macOS 13+ / iOS
//     16.4+), documented endpoint is web.push.apple.com; Apple's own
//     guidance is to allow any subdomain under push.apple.com rather than
//     hardcoding the exact host.
//   - updates.push.services.mozilla.com — Firefox's Mozilla autopush
//     service; this is specifically the HTTP endpoint app servers POST to
//     (push.services.mozilla.com, no "updates." prefix, is a separate
//     websocket-only host the browser itself holds open — not relevant
//     here since nothing on this server ever needs to reach that one).
//   - *.notify.windows.com — Windows Notification Service, used by desktop
//     Edge (Chromium Edge on Android instead uses FCM, same as other
//     Android browsers).
// Getting this list wrong doesn't fail loudly — it silently breaks push
// notifications for everyone on one entire platform, so err on the side of
// the suffix-matched entries covering documented subdomain variation rather
// than a single hardcoded hostname.
const PUSH_HOST_ALLOWLIST_EXACT = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
]);
const PUSH_HOST_ALLOWLIST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

// web-push (and, under it, Node's own https.request) has no timeout at all
// unless the caller passes one — an endpoint that accepts the TCP
// connection and then never responds ties up that socket indefinitely.
// Every webpush.sendNotification call site below passes this. All 5 sites
// are fire-and-forget (.catch(), never awaited in sequence — confirmed by
// reading each one), so a hung request only ever leaks one socket; it
// can't stall any other send. 10s is generous for a real push service
// under normal load while still bounding the worst case.
const PUSH_TIMEOUT_MS = 10000;

function isAllowedPushHost(hostname) {
  if (PUSH_HOST_ALLOWLIST_EXACT.has(hostname)) return true;
  return PUSH_HOST_ALLOWLIST_SUFFIXES.some(suffix => hostname.endsWith(suffix));
}

// Defense-in-depth, not a live gap — the closed allowlist above already
// makes an IP literal unreachable today (no real push service publishes
// one, so isAllowedPushHost rejects every IP literal already, implicitly).
// This exists so that if the allowlist is ever loosened later (a wildcard
// entry, a suffix broader than intended), an IP literal fails LOUDLY and
// explicitly right here instead of silently starting to slip through
// whatever the loosened allowlist now permits.
function isIpLiteral(hostname) {
  // WHATWG URL parsing keeps IPv6 literals bracketed and normalizes them
  // (new URL('https://[::ffff:127.0.0.1]/').hostname === '[::ffff:7f00:1]')
  // — but a colon can never appear in a real DNS hostname regardless of
  // exact form, so this alone catches every IPv6 shape, including the
  // ::ffff:-mapped IPv4-in-IPv6 form.
  if (hostname.includes(':')) return true;
  // IPv4 dotted-quad. Deliberately loose (not bounding each octet to
  // 0-255) — a real hostname is never all-digits-and-dots either way, so
  // over-rejecting here costs nothing.
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname);
}

// Returns a freshly-reconstructed {endpoint, keys:{p256dh,auth}} object
// built only from validated, expected fields — never the raw client-
// supplied object — so no extra attacker-chosen fields (or an
// attacker-inflated object used as unbounded storage) ever reach
// room.members. Returns null on anything invalid; the caller responds 400.
function validatePushSubscription(sub) {
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) return null;
  if (typeof sub.endpoint !== 'string') return null;
  let parsed;
  try { parsed = new URL(sub.endpoint); } catch (e) { return null; }
  if (parsed.protocol !== 'https:') return null;
  if (isIpLiteral(parsed.hostname)) return null;
  if (!isAllowedPushHost(parsed.hostname)) return null;
  const keys = sub.keys;
  if (!keys || typeof keys !== 'object') return null;
  if (typeof keys.p256dh !== 'string' || keys.p256dh.length === 0 || keys.p256dh.length > 255) return null;
  if (typeof keys.auth !== 'string' || keys.auth.length === 0 || keys.auth.length > 255) return null;
  // Shape, not just length — a real p256dh is an uncompressed P-256 EC
  // point (0x04 followed by 32-byte X and 32-byte Y, 65 bytes total) and a
  // real auth secret is 16 raw bytes. Buffer.from(..., 'base64url')
  // doesn't throw on malformed input (Node's base64 decoders are lenient),
  // it just produces the wrong length or wrong leading byte — which is
  // exactly what these two checks catch. Low-stakes cleanup, not a live
  // vulnerability fix: a malformed-but-plausible-length key before this
  // only ever failed harmlessly later, against the real push service.
  const p256dhBytes = Buffer.from(keys.p256dh, 'base64url');
  const authBytes = Buffer.from(keys.auth, 'base64url');
  if (p256dhBytes.length !== 65 || p256dhBytes[0] !== 0x04) return null;
  if (authBytes.length !== 16) return null;
  return { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

function formatTimerLabel(seconds) {
  if (!seconds) return 'off';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) { const m = Math.floor(seconds/60); return `${m} minute${m===1?'':'s'}`; }
  if (seconds < 86400) { const h = Math.floor(seconds/3600); return `${h} hour${h===1?'':'s'}`; }
  const days = Math.floor(seconds/86400); return `${days} day${days===1?'':'s'}`;
}

// EFF's long wordlist for Diceware passphrases (https://www.eff.org/dice,
// source file: https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt)
// — purpose-built for exactly this problem: phonetically distinct,
// unambiguous to spell, no shared prefixes that cause confusion when read
// aloud or typed by hand. The original list is 7,776 words; 4 are dropped
// here (drop-down, felt-tip, t-shirt, yo-yo) because they contain a hyphen
// themselves, which would break the hyphen-delimited code format below (or
// read as a confusing extra word boundary) — 7,772 remain.
const CODE_WORDLIST = [
  'abacus','abdomen','abdominal','abide','abiding','ability','ablaze','able','abnormal','abrasion','abrasive',
  'abreast','abridge','abroad','abruptly','absence','absentee','absently','absinthe','absolute','absolve','abstain',
  'abstract','absurd','accent','acclaim','acclimate','accompany','account','accuracy','accurate','accustom','acetone',
  'achiness','aching','acid','acorn','acquaint','acquire','acre','acrobat','acronym','acting','action','activate',
  'activator','active','activism','activist','activity','actress','acts','acutely','acuteness','aeration','aerobics',
  'aerosol','aerospace','afar','affair','affected','affecting','affection','affidavit','affiliate','affirm','affix',
  'afflicted','affluent','afford','affront','aflame','afloat','aflutter','afoot','afraid','afterglow','afterlife',
  'aftermath','aftermost','afternoon','aged','ageless','agency','agenda','agent','aggregate','aghast','agile',
  'agility','aging','agnostic','agonize','agonizing','agony','agreeable','agreeably','agreed','agreeing','agreement',
  'aground','ahead','ahoy','aide','aids','aim','ajar','alabaster','alarm','albatross','album','alfalfa','algebra',
  'algorithm','alias','alibi','alienable','alienate','aliens','alike','alive','alkaline','alkalize','almanac',
  'almighty','almost','aloe','aloft','aloha','alone','alongside','aloof','alphabet','alright','although','altitude',
  'alto','aluminum','alumni','always','amaretto','amaze','amazingly','amber','ambiance','ambiguity','ambiguous',
  'ambition','ambitious','ambulance','ambush','amendable','amendment','amends','amenity','amiable','amicably','amid',
  'amigo','amino','amiss','ammonia','ammonium','amnesty','amniotic','among','amount','amperage','ample','amplifier',
  'amplify','amply','amuck','amulet','amusable','amused','amusement','amuser','amusing','anaconda','anaerobic',
  'anagram','anatomist','anatomy','anchor','anchovy','ancient','android','anemia','anemic','aneurism','anew',
  'angelfish','angelic','anger','angled','angler','angles','angling','angrily','angriness','anguished','angular',
  'animal','animate','animating','animation','animator','anime','animosity','ankle','annex','annotate','announcer',
  'annoying','annually','annuity','anointer','another','answering','antacid','antarctic','anteater','antelope',
  'antennae','anthem','anthill','anthology','antibody','antics','antidote','antihero','antiquely','antiques',
  'antiquity','antirust','antitoxic','antitrust','antiviral','antivirus','antler','antonym','antsy','anvil','anybody',
  'anyhow','anymore','anyone','anyplace','anything','anytime','anyway','anywhere','aorta','apache','apostle',
  'appealing','appear','appease','appeasing','appendage','appendix','appetite','appetizer','applaud','applause',
  'apple','appliance','applicant','applied','apply','appointee','appraisal','appraiser','apprehend','approach',
  'approval','approve','apricot','april','apron','aptitude','aptly','aqua','aqueduct','arbitrary','arbitrate',
  'ardently','area','arena','arguable','arguably','argue','arise','armadillo','armband','armchair','armed','armful',
  'armhole','arming','armless','armoire','armored','armory','armrest','army','aroma','arose','around','arousal',
  'arrange','array','arrest','arrival','arrive','arrogance','arrogant','arson','art','ascend','ascension','ascent',
  'ascertain','ashamed','ashen','ashes','ashy','aside','askew','asleep','asparagus','aspect','aspirate','aspire',
  'aspirin','astonish','astound','astride','astrology','astronaut','astronomy','astute','atlantic','atlas','atom',
  'atonable','atop','atrium','atrocious','atrophy','attach','attain','attempt','attendant','attendee','attention',
  'attentive','attest','attic','attire','attitude','attractor','attribute','atypical','auction','audacious',
  'audacity','audible','audibly','audience','audio','audition','augmented','august','authentic','author','autism',
  'autistic','autograph','automaker','automated','automatic','autopilot','available','avalanche','avatar','avenge',
  'avenging','avenue','average','aversion','avert','aviation','aviator','avid','avoid','await','awaken','award',
  'aware','awhile','awkward','awning','awoke','awry','axis','babble','babbling','babied','baboon','backache',
  'backboard','backboned','backdrop','backed','backer','backfield','backfire','backhand','backing','backlands',
  'backlash','backless','backlight','backlit','backlog','backpack','backpedal','backrest','backroom','backshift',
  'backside','backslid','backspace','backspin','backstab','backstage','backtalk','backtrack','backup','backward',
  'backwash','backwater','backyard','bacon','bacteria','bacterium','badass','badge','badland','badly','badness',
  'baffle','baffling','bagel','bagful','baggage','bagged','baggie','bagginess','bagging','baggy','bagpipe','baguette',
  'baked','bakery','bakeshop','baking','balance','balancing','balcony','balmy','balsamic','bamboo','banana','banish',
  'banister','banjo','bankable','bankbook','banked','banker','banking','banknote','bankroll','banner','bannister',
  'banshee','banter','barbecue','barbed','barbell','barber','barcode','barge','bargraph','barista','baritone',
  'barley','barmaid','barman','barn','barometer','barrack','barracuda','barrel','barrette','barricade','barrier',
  'barstool','bartender','barterer','bash','basically','basics','basil','basin','basis','basket','batboy','batch',
  'bath','baton','bats','battalion','battered','battering','battery','batting','battle','bauble','bazooka','blabber',
  'bladder','blade','blah','blame','blaming','blanching','blandness','blank','blaspheme','blasphemy','blast',
  'blatancy','blatantly','blazer','blazing','bleach','bleak','bleep','blemish','blend','bless','blighted','blimp',
  'bling','blinked','blinker','blinking','blinks','blip','blissful','blitz','blizzard','bloated','bloating','blob',
  'blog','bloomers','blooming','blooper','blot','blouse','blubber','bluff','bluish','blunderer','blunt','blurb',
  'blurred','blurry','blurt','blush','blustery','boaster','boastful','boasting','boat','bobbed','bobbing','bobble',
  'bobcat','bobsled','bobtail','bodacious','body','bogged','boggle','bogus','boil','bok','bolster','bolt','bonanza',
  'bonded','bonding','bondless','boned','bonehead','boneless','bonelike','boney','bonfire','bonnet','bonsai','bonus',
  'bony','boogeyman','boogieman','book','boondocks','booted','booth','bootie','booting','bootlace','bootleg','boots',
  'boozy','borax','boring','borough','borrower','borrowing','boss','botanical','botanist','botany','botch','both',
  'bottle','bottling','bottom','bounce','bouncing','bouncy','bounding','boundless','bountiful','bovine','boxcar',
  'boxer','boxing','boxlike','boxy','breach','breath','breeches','breeching','breeder','breeding','breeze','breezy',
  'brethren','brewery','brewing','briar','bribe','brick','bride','bridged','brigade','bright','brilliant','brim',
  'bring','brink','brisket','briskly','briskness','bristle','brittle','broadband','broadcast','broaden','broadly',
  'broadness','broadside','broadways','broiler','broiling','broken','broker','bronchial','bronco','bronze','bronzing',
  'brook','broom','brought','browbeat','brownnose','browse','browsing','bruising','brunch','brunette','brunt','brush',
  'brussels','brute','brutishly','bubble','bubbling','bubbly','buccaneer','bucked','bucket','buckle','buckshot',
  'buckskin','bucktooth','buckwheat','buddhism','buddhist','budding','buddy','budget','buffalo','buffed','buffer',
  'buffing','buffoon','buggy','bulb','bulge','bulginess','bulgur','bulk','bulldog','bulldozer','bullfight','bullfrog',
  'bullhorn','bullion','bullish','bullpen','bullring','bullseye','bullwhip','bully','bunch','bundle','bungee',
  'bunion','bunkbed','bunkhouse','bunkmate','bunny','bunt','busboy','bush','busily','busload','bust','busybody',
  'buzz','cabana','cabbage','cabbie','cabdriver','cable','caboose','cache','cackle','cacti','cactus','caddie','caddy',
  'cadet','cadillac','cadmium','cage','cahoots','cake','calamari','calamity','calcium','calculate','calculus',
  'caliber','calibrate','calm','caloric','calorie','calzone','camcorder','cameo','camera','camisole','camper',
  'campfire','camping','campsite','campus','canal','canary','cancel','candied','candle','candy','cane','canine',
  'canister','cannabis','canned','canning','cannon','cannot','canola','canon','canopener','canopy','canteen','canyon',
  'capable','capably','capacity','cape','capillary','capital','capitol','capped','capricorn','capsize','capsule',
  'caption','captivate','captive','captivity','capture','caramel','carat','caravan','carbon','cardboard','carded',
  'cardiac','cardigan','cardinal','cardstock','carefully','caregiver','careless','caress','caretaker','cargo',
  'caring','carless','carload','carmaker','carnage','carnation','carnival','carnivore','carol','carpenter',
  'carpentry','carpool','carport','carried','carrot','carrousel','carry','cartel','cartload','carton','cartoon',
  'cartridge','cartwheel','carve','carving','carwash','cascade','case','cash','casing','casino','casket','cassette',
  'casually','casualty','catacomb','catalog','catalyst','catalyze','catapult','cataract','catatonic','catcall',
  'catchable','catcher','catching','catchy','caterer','catering','catfight','catfish','cathedral','cathouse',
  'catlike','catnap','catnip','catsup','cattail','cattishly','cattle','catty','catwalk','caucasian','caucus','causal',
  'causation','cause','causing','cauterize','caution','cautious','cavalier','cavalry','caviar','cavity','cedar',
  'celery','celestial','celibacy','celibate','celtic','cement','census','ceramics','ceremony','certainly','certainty',
  'certified','certify','cesarean','cesspool','chafe','chaffing','chain','chair','chalice','challenge','chamber',
  'chamomile','champion','chance','change','channel','chant','chaos','chaperone','chaplain','chapped','chaps',
  'chapter','character','charbroil','charcoal','charger','charging','chariot','charity','charm','charred','charter',
  'charting','chase','chasing','chaste','chastise','chastity','chatroom','chatter','chatting','chatty','cheating',
  'cheddar','cheek','cheer','cheese','cheesy','chef','chemicals','chemist','chemo','cherisher','cherub','chess',
  'chest','chevron','chevy','chewable','chewer','chewing','chewy','chief','chihuahua','childcare','childhood',
  'childish','childless','childlike','chili','chill','chimp','chip','chirping','chirpy','chitchat','chivalry','chive',
  'chloride','chlorine','choice','chokehold','choking','chomp','chooser','choosing','choosy','chop','chosen',
  'chowder','chowtime','chrome','chubby','chuck','chug','chummy','chump','chunk','churn','chute','cider','cilantro',
  'cinch','cinema','cinnamon','circle','circling','circular','circulate','circus','citable','citadel','citation',
  'citizen','citric','citrus','city','civic','civil','clad','claim','clambake','clammy','clamor','clamp','clamshell',
  'clang','clanking','clapped','clapper','clapping','clarify','clarinet','clarity','clash','clasp','class','clatter',
  'clause','clavicle','claw','clay','clean','clear','cleat','cleaver','cleft','clench','clergyman','clerical','clerk',
  'clever','clicker','client','climate','climatic','cling','clinic','clinking','clip','clique','cloak','clobber',
  'clock','clone','cloning','closable','closure','clothes','clothing','cloud','clover','clubbed','clubbing',
  'clubhouse','clump','clumsily','clumsy','clunky','clustered','clutch','clutter','coach','coagulant','coastal',
  'coaster','coasting','coastland','coastline','coat','coauthor','cobalt','cobbler','cobweb','cocoa','coconut','cod',
  'coeditor','coerce','coexist','coffee','cofounder','cognition','cognitive','cogwheel','coherence','coherent',
  'cohesive','coil','coke','cola','cold','coleslaw','coliseum','collage','collapse','collar','collected','collector',
  'collide','collie','collision','colonial','colonist','colonize','colony','colossal','colt','coma','come','comfort',
  'comfy','comic','coming','comma','commence','commend','comment','commerce','commode','commodity','commodore',
  'common','commotion','commute','commuting','compacted','compacter','compactly','compactor','companion','company',
  'compare','compel','compile','comply','component','composed','composer','composite','compost','composure',
  'compound','compress','comprised','computer','computing','comrade','concave','conceal','conceded','concept',
  'concerned','concert','conch','concierge','concise','conclude','concrete','concur','condense','condiment',
  'condition','condone','conducive','conductor','conduit','cone','confess','confetti','confidant','confident',
  'confider','confiding','configure','confined','confining','confirm','conflict','conform','confound','confront',
  'confused','confusing','confusion','congenial','congested','congrats','congress','conical','conjoined','conjure',
  'conjuror','connected','connector','consensus','consent','console','consoling','consonant','constable','constant',
  'constrain','constrict','construct','consult','consumer','consuming','contact','container','contempt','contend',
  'contented','contently','contents','contest','context','contort','contour','contrite','control','contusion',
  'convene','convent','copartner','cope','copied','copier','copilot','coping','copious','copper','copy','coral',
  'cork','cornball','cornbread','corncob','cornea','corned','corner','cornfield','cornflake','cornhusk','cornmeal',
  'cornstalk','corny','coronary','coroner','corporal','corporate','corral','correct','corridor','corrode','corroding',
  'corrosive','corsage','corset','cortex','cosigner','cosmetics','cosmic','cosmos','cosponsor','cost','cottage',
  'cotton','couch','cough','could','countable','countdown','counting','countless','country','county','courier',
  'covenant','cover','coveted','coveting','coyness','cozily','coziness','cozy','crabbing','crabgrass','crablike',
  'crabmeat','cradle','cradling','crafter','craftily','craftsman','craftwork','crafty','cramp','cranberry','crane',
  'cranial','cranium','crank','crate','crave','craving','crawfish','crawlers','crawling','crayfish','crayon','crazed',
  'crazily','craziness','crazy','creamed','creamer','creamlike','crease','creasing','creatable','create','creation',
  'creative','creature','credible','credibly','credit','creed','creme','creole','crepe','crept','crescent','crested',
  'cresting','crestless','crevice','crewless','crewman','crewmate','crib','cricket','cried','crier','crimp','crimson',
  'cringe','cringing','crinkle','crinkly','crisped','crisping','crisply','crispness','crispy','criteria','critter',
  'croak','crock','crook','croon','crop','cross','crouch','crouton','crowbar','crowd','crown','crucial','crudely',
  'crudeness','cruelly','cruelness','cruelty','crumb','crummiest','crummy','crumpet','crumpled','cruncher',
  'crunching','crunchy','crusader','crushable','crushed','crusher','crushing','crust','crux','crying','cryptic',
  'crystal','cubbyhole','cube','cubical','cubicle','cucumber','cuddle','cuddly','cufflink','culinary','culminate',
  'culpable','culprit','cultivate','cultural','culture','cupbearer','cupcake','cupid','cupped','cupping','curable',
  'curator','curdle','cure','curfew','curing','curled','curler','curliness','curling','curly','curry','curse',
  'cursive','cursor','curtain','curtly','curtsy','curvature','curve','curvy','cushy','cusp','cussed','custard',
  'custodian','custody','customary','customer','customize','customs','cut','cycle','cyclic','cycling','cyclist',
  'cylinder','cymbal','cytoplasm','cytoplast','dab','dad','daffodil','dagger','daily','daintily','dainty','dairy',
  'daisy','dallying','dance','dancing','dandelion','dander','dandruff','dandy','danger','dangle','dangling',
  'daredevil','dares','daringly','darkened','darkening','darkish','darkness','darkroom','darling','darn','dart',
  'darwinism','dash','dastardly','data','datebook','dating','daughter','daunting','dawdler','dawn','daybed',
  'daybreak','daycare','daydream','daylight','daylong','dayroom','daytime','dazzler','dazzling','deacon','deafening',
  'deafness','dealer','dealing','dealmaker','dealt','dean','debatable','debate','debating','debit','debrief',
  'debtless','debtor','debug','debunk','decade','decaf','decal','decathlon','decay','deceased','deceit','deceiver',
  'deceiving','december','decency','decent','deception','deceptive','decibel','decidable','decimal','decimeter',
  'decipher','deck','declared','decline','decode','decompose','decorated','decorator','decoy','decrease','decree',
  'dedicate','dedicator','deduce','deduct','deed','deem','deepen','deeply','deepness','deface','defacing','defame',
  'default','defeat','defection','defective','defendant','defender','defense','defensive','deferral','deferred',
  'defiance','defiant','defile','defiling','define','definite','deflate','deflation','deflator','deflected',
  'deflector','defog','deforest','defraud','defrost','deftly','defuse','defy','degraded','degrading','degrease',
  'degree','dehydrate','deity','dejected','delay','delegate','delegator','delete','deletion','delicacy','delicate',
  'delicious','delighted','delirious','delirium','deliverer','delivery','delouse','delta','deluge','delusion',
  'deluxe','demanding','demeaning','demeanor','demise','democracy','democrat','demote','demotion','demystify',
  'denatured','deniable','denial','denim','denote','dense','density','dental','dentist','denture','deny','deodorant',
  'deodorize','departed','departure','depict','deplete','depletion','deplored','deploy','deport','depose','depraved',
  'depravity','deprecate','depress','deprive','depth','deputize','deputy','derail','deranged','derby','derived',
  'desecrate','deserve','deserving','designate','designed','designer','designing','deskbound','desktop','deskwork',
  'desolate','despair','despise','despite','destiny','destitute','destruct','detached','detail','detection',
  'detective','detector','detention','detergent','detest','detonate','detonator','detoxify','detract','deuce',
  'devalue','deviancy','deviant','deviate','deviation','deviator','device','devious','devotedly','devotee','devotion',
  'devourer','devouring','devoutly','dexterity','dexterous','diabetes','diabetic','diabolic','diagnoses','diagnosis',
  'diagram','dial','diameter','diaper','diaphragm','diary','dice','dicing','dictate','dictation','dictator',
  'difficult','diffused','diffuser','diffusion','diffusive','dig','dilation','diligence','diligent','dill','dilute',
  'dime','diminish','dimly','dimmed','dimmer','dimness','dimple','diner','dingbat','dinghy','dinginess','dingo',
  'dingy','dining','dinner','diocese','dioxide','diploma','dipped','dipper','dipping','directed','direction',
  'directive','directly','directory','direness','dirtiness','disabled','disagree','disallow','disarm','disarray',
  'disaster','disband','disbelief','disburse','discard','discern','discharge','disclose','discolor','discount',
  'discourse','discover','discuss','disdain','disengage','disfigure','disgrace','dish','disinfect','disjoin','disk',
  'dislike','disliking','dislocate','dislodge','disloyal','dismantle','dismay','dismiss','dismount','disobey',
  'disorder','disown','disparate','disparity','dispatch','dispense','dispersal','dispersed','disperser','displace',
  'display','displease','disposal','dispose','disprove','dispute','disregard','disrupt','dissuade','distance',
  'distant','distaste','distill','distinct','distort','distract','distress','district','distrust','ditch','ditto',
  'ditzy','dividable','divided','dividend','dividers','dividing','divinely','diving','divinity','divisible',
  'divisibly','division','divisive','divorcee','dizziness','dizzy','doable','docile','dock','doctrine','document',
  'dodge','dodgy','doily','doing','dole','dollar','dollhouse','dollop','dolly','dolphin','domain','domelike',
  'domestic','dominion','dominoes','donated','donation','donator','donor','donut','doodle','doorbell','doorframe',
  'doorknob','doorman','doormat','doornail','doorpost','doorstep','doorstop','doorway','doozy','dork','dormitory',
  'dorsal','dosage','dose','dotted','doubling','douche','dove','down','dowry','doze','drab','dragging','dragonfly',
  'dragonish','dragster','drainable','drainage','drained','drainer','drainpipe','dramatic','dramatize','drank',
  'drapery','drastic','draw','dreaded','dreadful','dreadlock','dreamboat','dreamily','dreamland','dreamless',
  'dreamlike','dreamt','dreamy','drearily','dreary','drench','dress','drew','dribble','dried','drier','drift',
  'driller','drilling','drinkable','drinking','dripping','drippy','drivable','driven','driver','driveway','driving',
  'drizzle','drizzly','drone','drool','droop','dropbox','dropkick','droplet','dropout','dropper','drove','drown',
  'drowsily','drudge','drum','dry','dubbed','dubiously','duchess','duckbill','ducking','duckling','ducktail','ducky',
  'duct','dude','duffel','dugout','duh','duke','duller','dullness','duly','dumping','dumpling','dumpster','duo',
  'dupe','duplex','duplicate','duplicity','durable','durably','duration','duress','during','dusk','dust','dutiful',
  'duty','duvet','dwarf','dweeb','dwelled','dweller','dwelling','dwindle','dwindling','dynamic','dynamite','dynasty',
  'dyslexia','dyslexic','each','eagle','earache','eardrum','earflap','earful','earlobe','early','earmark','earmuff',
  'earphone','earpiece','earplugs','earring','earshot','earthen','earthlike','earthling','earthly','earthworm',
  'earthy','earwig','easeful','easel','easiest','easily','easiness','easing','eastbound','eastcoast','easter',
  'eastward','eatable','eaten','eatery','eating','eats','ebay','ebony','ebook','ecard','eccentric','echo','eclair',
  'eclipse','ecologist','ecology','economic','economist','economy','ecosphere','ecosystem','edge','edginess','edging',
  'edgy','edition','editor','educated','education','educator','eel','effective','effects','efficient','effort',
  'eggbeater','egging','eggnog','eggplant','eggshell','egomaniac','egotism','egotistic','either','eject','elaborate',
  'elastic','elated','elbow','eldercare','elderly','eldest','electable','election','elective','elephant','elevate',
  'elevating','elevation','elevator','eleven','elf','eligible','eligibly','eliminate','elite','elitism','elixir',
  'elk','ellipse','elliptic','elm','elongated','elope','eloquence','eloquent','elsewhere','elude','elusive','elves',
  'email','embargo','embark','embassy','embattled','embellish','ember','embezzle','emblaze','emblem','embody',
  'embolism','emboss','embroider','emcee','emerald','emergency','emission','emit','emote','emoticon','emotion',
  'empathic','empathy','emperor','emphases','emphasis','emphasize','emphatic','empirical','employed','employee',
  'employer','emporium','empower','emptier','emptiness','empty','emu','enable','enactment','enamel','enchanted',
  'enchilada','encircle','enclose','enclosure','encode','encore','encounter','encourage','encroach','encrust',
  'encrypt','endanger','endeared','endearing','ended','ending','endless','endnote','endocrine','endorphin','endorse',
  'endowment','endpoint','endurable','endurance','enduring','energetic','energize','energy','enforced','enforcer',
  'engaged','engaging','engine','engorge','engraved','engraver','engraving','engross','engulf','enhance','enigmatic',
  'enjoyable','enjoyably','enjoyer','enjoying','enjoyment','enlarged','enlarging','enlighten','enlisted','enquirer',
  'enrage','enrich','enroll','enslave','ensnare','ensure','entail','entangled','entering','entertain','enticing',
  'entire','entitle','entity','entomb','entourage','entrap','entree','entrench','entrust','entryway','entwine',
  'enunciate','envelope','enviable','enviably','envious','envision','envoy','envy','enzyme','epic','epidemic',
  'epidermal','epidermis','epidural','epilepsy','epileptic','epilogue','epiphany','episode','equal','equate',
  'equation','equator','equinox','equipment','equity','equivocal','eradicate','erasable','erased','eraser','erasure',
  'ergonomic','errand','errant','erratic','error','erupt','escalate','escalator','escapable','escapade','escapist',
  'escargot','eskimo','esophagus','espionage','espresso','esquire','essay','essence','essential','establish','estate',
  'esteemed','estimate','estimator','estranged','estrogen','etching','eternal','eternity','ethanol','ether',
  'ethically','ethics','euphemism','evacuate','evacuee','evade','evaluate','evaluator','evaporate','evasion',
  'evasive','even','everglade','evergreen','everybody','everyday','everyone','evict','evidence','evident','evil',
  'evoke','evolution','evolve','exact','exalted','example','excavate','excavator','exceeding','exception','excess',
  'exchange','excitable','exciting','exclaim','exclude','excluding','exclusion','exclusive','excretion','excretory',
  'excursion','excusable','excusably','excuse','exemplary','exemplify','exemption','exerciser','exert','exes',
  'exfoliate','exhale','exhaust','exhume','exile','existing','exit','exodus','exonerate','exorcism','exorcist',
  'expand','expanse','expansion','expansive','expectant','expedited','expediter','expel','expend','expenses',
  'expensive','expert','expire','expiring','explain','expletive','explicit','explode','exploit','explore','exploring',
  'exponent','exporter','exposable','expose','exposure','express','expulsion','exquisite','extended','extending',
  'extent','extenuate','exterior','external','extinct','extortion','extradite','extras','extrovert','extrude',
  'extruding','exuberant','fable','fabric','fabulous','facebook','facecloth','facedown','faceless','facelift',
  'faceplate','faceted','facial','facility','facing','facsimile','faction','factoid','factor','factsheet','factual',
  'faculty','fade','fading','failing','falcon','fall','false','falsify','fame','familiar','family','famine',
  'famished','fanatic','fancied','fanciness','fancy','fanfare','fang','fanning','fantasize','fantastic','fantasy',
  'fascism','fastball','faster','fasting','fastness','faucet','favorable','favorably','favored','favoring','favorite',
  'fax','feast','federal','fedora','feeble','feed','feel','feisty','feline','feminine','feminism','feminist',
  'feminize','femur','fence','fencing','fender','ferment','fernlike','ferocious','ferocity','ferret','ferris','ferry',
  'fervor','fester','festival','festive','festivity','fetal','fetch','fever','fiber','fiction','fiddle','fiddling',
  'fidelity','fidgeting','fidgety','fifteen','fifth','fiftieth','fifty','figment','figure','figurine','filing',
  'filled','filler','filling','film','filter','filth','filtrate','finale','finalist','finalize','finally','finance',
  'financial','finch','fineness','finer','finicky','finished','finisher','finishing','finite','finless','finlike',
  'fiscally','fit','five','flaccid','flagman','flagpole','flagship','flagstick','flagstone','flail','flakily','flaky',
  'flame','flammable','flanked','flanking','flannels','flap','flaring','flashback','flashbulb','flashcard','flashily',
  'flashing','flashy','flask','flatbed','flatfoot','flatly','flatness','flatten','flattered','flatterer','flattery',
  'flattop','flatware','flatworm','flavored','flavorful','flavoring','flaxseed','fled','fleshed','fleshy','flick',
  'flier','flight','flinch','fling','flint','flip','flirt','float','flock','flogging','flop','floral','florist',
  'floss','flounder','flyable','flyaway','flyer','flying','flyover','flypaper','foam','foe','fog','foil','folic',
  'folk','follicle','follow','fondling','fondly','fondness','fondue','font','food','fool','footage','football',
  'footbath','footboard','footer','footgear','foothill','foothold','footing','footless','footman','footnote',
  'footpad','footpath','footprint','footrest','footsie','footsore','footwear','footwork','fossil','foster','founder',
  'founding','fountain','fox','foyer','fraction','fracture','fragile','fragility','fragment','fragrance','fragrant',
  'frail','frame','framing','frantic','fraternal','frayed','fraying','frays','freckled','freckles','freebase',
  'freebee','freebie','freedom','freefall','freehand','freeing','freeload','freely','freemason','freeness',
  'freestyle','freeware','freeway','freewill','freezable','freezing','freight','french','frenzied','frenzy',
  'frequency','frequent','fresh','fretful','fretted','friction','friday','fridge','fried','friend','frighten',
  'frightful','frigidity','frigidly','frill','fringe','frisbee','frisk','fritter','frivolous','frolic','from','front',
  'frostbite','frosted','frostily','frosting','frostlike','frosty','froth','frown','frozen','fructose','frugality',
  'frugally','fruit','frustrate','frying','gab','gaffe','gag','gainfully','gaining','gains','gala','gallantly',
  'galleria','gallery','galley','gallon','gallows','gallstone','galore','galvanize','gambling','game','gaming',
  'gamma','gander','gangly','gangrene','gangway','gap','garage','garbage','garden','gargle','garland','garlic',
  'garment','garnet','garnish','garter','gas','gatherer','gathering','gating','gauging','gauntlet','gauze','gave',
  'gawk','gazing','gear','gecko','geek','geiger','gem','gender','generic','generous','genetics','genre','gentile',
  'gentleman','gently','gents','geography','geologic','geologist','geology','geometric','geometry','geranium',
  'gerbil','geriatric','germicide','germinate','germless','germproof','gestate','gestation','gesture','getaway',
  'getting','getup','giant','gibberish','giblet','giddily','giddiness','giddy','gift','gigabyte','gigahertz',
  'gigantic','giggle','giggling','giggly','gigolo','gilled','gills','gimmick','girdle','giveaway','given','giver',
  'giving','gizmo','gizzard','glacial','glacier','glade','gladiator','gladly','glamorous','glamour','glance',
  'glancing','glandular','glare','glaring','glass','glaucoma','glazing','gleaming','gleeful','glider','gliding',
  'glimmer','glimpse','glisten','glitch','glitter','glitzy','gloater','gloating','gloomily','gloomy','glorified',
  'glorifier','glorify','glorious','glory','gloss','glove','glowing','glowworm','glucose','glue','gluten','glutinous',
  'glutton','gnarly','gnat','goal','goatskin','goes','goggles','going','goldfish','goldmine','goldsmith','golf',
  'goliath','gonad','gondola','gone','gong','good','gooey','goofball','goofiness','goofy','google','goon','gopher',
  'gore','gorged','gorgeous','gory','gosling','gossip','gothic','gotten','gout','gown','grab','graceful','graceless',
  'gracious','gradation','graded','grader','gradient','grading','gradually','graduate','graffiti','grafted',
  'grafting','grain','granddad','grandkid','grandly','grandma','grandpa','grandson','granite','granny','granola',
  'grant','granular','grape','graph','grapple','grappling','grasp','grass','gratified','gratify','grating',
  'gratitude','gratuity','gravel','graveness','graves','graveyard','gravitate','gravity','gravy','gray','grazing',
  'greasily','greedily','greedless','greedy','green','greeter','greeting','grew','greyhound','grid','grief',
  'grievance','grieving','grievous','grill','grimace','grimacing','grime','griminess','grimy','grinch','grinning',
  'grip','gristle','grit','groggily','groggy','groin','groom','groove','grooving','groovy','grope','ground','grouped',
  'grout','grove','grower','growing','growl','grub','grudge','grudging','grueling','gruffly','grumble','grumbling',
  'grumbly','grumpily','grunge','grunt','guacamole','guidable','guidance','guide','guiding','guileless','guise',
  'gulf','gullible','gully','gulp','gumball','gumdrop','gumminess','gumming','gummy','gurgle','gurgling','guru',
  'gush','gusto','gusty','gutless','guts','gutter','guy','guzzler','gyration','habitable','habitant','habitat',
  'habitual','hacked','hacker','hacking','hacksaw','had','haggler','haiku','half','halogen','halt','halved','halves',
  'hamburger','hamlet','hammock','hamper','hamster','hamstring','handbag','handball','handbook','handbrake',
  'handcart','handclap','handclasp','handcraft','handcuff','handed','handful','handgrip','handgun','handheld',
  'handiness','handiwork','handlebar','handled','handler','handling','handmade','handoff','handpick','handprint',
  'handrail','handsaw','handset','handsfree','handshake','handstand','handwash','handwork','handwoven','handwrite',
  'handyman','hangnail','hangout','hangover','hangup','hankering','hankie','hanky','haphazard','happening','happier',
  'happiest','happily','happiness','happy','harbor','hardcopy','hardcore','hardcover','harddisk','hardened',
  'hardener','hardening','hardhat','hardhead','hardiness','hardly','hardness','hardship','hardware','hardwired',
  'hardwood','hardy','harmful','harmless','harmonica','harmonics','harmonize','harmony','harness','harpist','harsh',
  'harvest','hash','hassle','haste','hastily','hastiness','hasty','hatbox','hatchback','hatchery','hatchet',
  'hatching','hatchling','hate','hatless','hatred','haunt','haven','hazard','hazelnut','hazily','haziness','hazing',
  'hazy','headache','headband','headboard','headcount','headdress','headed','header','headfirst','headgear','heading',
  'headlamp','headless','headlock','headphone','headpiece','headrest','headroom','headscarf','headset','headsman',
  'headstand','headstone','headway','headwear','heap','heat','heave','heavily','heaviness','heaving','hedge',
  'hedging','heftiness','hefty','helium','helmet','helper','helpful','helping','helpless','helpline','hemlock',
  'hemstitch','hence','henchman','henna','herald','herbal','herbicide','herbs','heritage','hermit','heroics',
  'heroism','herring','herself','hertz','hesitancy','hesitant','hesitate','hexagon','hexagram','hubcap','huddle',
  'huddling','huff','hug','hula','hulk','hull','human','humble','humbling','humbly','humid','humiliate','humility',
  'humming','hummus','humongous','humorist','humorless','humorous','humpback','humped','humvee','hunchback',
  'hundredth','hunger','hungrily','hungry','hunk','hunter','hunting','huntress','huntsman','hurdle','hurled','hurler',
  'hurling','hurray','hurricane','hurried','hurry','hurt','husband','hush','husked','huskiness','hut','hybrid',
  'hydrant','hydrated','hydration','hydrogen','hydroxide','hyperlink','hypertext','hyphen','hypnoses','hypnosis',
  'hypnotic','hypnotism','hypnotist','hypnotize','hypocrisy','hypocrite','ibuprofen','ice','iciness','icing','icky',
  'icon','icy','idealism','idealist','idealize','ideally','idealness','identical','identify','identity','ideology',
  'idiocy','idiom','idly','igloo','ignition','ignore','iguana','illicitly','illusion','illusive','image','imaginary',
  'imagines','imaging','imbecile','imitate','imitation','immature','immerse','immersion','imminent','immobile',
  'immodest','immorally','immortal','immovable','immovably','immunity','immunize','impaired','impale','impart',
  'impatient','impeach','impeding','impending','imperfect','imperial','impish','implant','implement','implicate',
  'implicit','implode','implosion','implosive','imply','impolite','important','importer','impose','imposing',
  'impotence','impotency','impotent','impound','imprecise','imprint','imprison','impromptu','improper','improve',
  'improving','improvise','imprudent','impulse','impulsive','impure','impurity','iodine','iodize','ion','ipad',
  'iphone','ipod','irate','irk','iron','irregular','irrigate','irritable','irritably','irritant','irritate','islamic',
  'islamist','isolated','isolating','isolation','isotope','issue','issuing','italicize','italics','item','itinerary',
  'itunes','ivory','ivy','jab','jackal','jacket','jackknife','jackpot','jailbird','jailbreak','jailer','jailhouse',
  'jalapeno','jam','janitor','january','jargon','jarring','jasmine','jaundice','jaunt','java','jawed','jawless',
  'jawline','jaws','jaybird','jaywalker','jazz','jeep','jeeringly','jellied','jelly','jersey','jester','jet','jiffy',
  'jigsaw','jimmy','jingle','jingling','jinx','jitters','jittery','job','jockey','jockstrap','jogger','jogging',
  'john','joining','jokester','jokingly','jolliness','jolly','jolt','jot','jovial','joyfully','joylessly','joyous',
  'joyride','joystick','jubilance','jubilant','judge','judgingly','judicial','judiciary','judo','juggle','juggling',
  'jugular','juice','juiciness','juicy','jujitsu','jukebox','july','jumble','jumbo','jump','junction','juncture',
  'june','junior','juniper','junkie','junkman','junkyard','jurist','juror','jury','justice','justifier','justify',
  'justly','justness','juvenile','kabob','kangaroo','karaoke','karate','karma','kebab','keenly','keenness','keep',
  'keg','kelp','kennel','kept','kerchief','kerosene','kettle','kick','kiln','kilobyte','kilogram','kilometer',
  'kilowatt','kilt','kimono','kindle','kindling','kindly','kindness','kindred','kinetic','kinfolk','king','kinship',
  'kinsman','kinswoman','kissable','kisser','kissing','kitchen','kite','kitten','kitty','kiwi','kleenex','knapsack',
  'knee','knelt','knickers','knoll','koala','kooky','kosher','krypton','kudos','kung','labored','laborer','laboring',
  'laborious','labrador','ladder','ladies','ladle','ladybug','ladylike','lagged','lagging','lagoon','lair','lake',
  'lance','landed','landfall','landfill','landing','landlady','landless','landline','landlord','landmark','landmass',
  'landmine','landowner','landscape','landside','landslide','language','lankiness','lanky','lantern','lapdog','lapel',
  'lapped','lapping','laptop','lard','large','lark','lash','lasso','last','latch','late','lather','latitude',
  'latrine','latter','latticed','launch','launder','laundry','laurel','lavender','lavish','laxative','lazily',
  'laziness','lazy','lecturer','left','legacy','legal','legend','legged','leggings','legible','legibly','legislate',
  'lego','legroom','legume','legwarmer','legwork','lemon','lend','length','lens','lent','leotard','lesser','letdown',
  'lethargic','lethargy','letter','lettuce','level','leverage','levers','levitate','levitator','liability','liable',
  'liberty','librarian','library','licking','licorice','lid','life','lifter','lifting','liftoff','ligament','likely',
  'likeness','likewise','liking','lilac','lilly','lily','limb','limeade','limelight','limes','limit','limping',
  'limpness','line','lingo','linguini','linguist','lining','linked','linoleum','linseed','lint','lion','lip',
  'liquefy','liqueur','liquid','lisp','list','litigate','litigator','litmus','litter','little','livable','lived',
  'lively','liver','livestock','lividly','living','lizard','lubricant','lubricate','lucid','luckily','luckiness',
  'luckless','lucrative','ludicrous','lugged','lukewarm','lullaby','lumber','luminance','luminous','lumpiness',
  'lumping','lumpish','lunacy','lunar','lunchbox','luncheon','lunchroom','lunchtime','lung','lurch','lure',
  'luridness','lurk','lushly','lushness','luster','lustfully','lustily','lustiness','lustrous','lusty','luxurious',
  'luxury','lying','lyrically','lyricism','lyricist','lyrics','macarena','macaroni','macaw','mace','machine',
  'machinist','magazine','magenta','maggot','magical','magician','magma','magnesium','magnetic','magnetism',
  'magnetize','magnifier','magnify','magnitude','magnolia','mahogany','maimed','majestic','majesty','majorette',
  'majority','makeover','maker','makeshift','making','malformed','malt','mama','mammal','mammary','mammogram',
  'manager','managing','manatee','mandarin','mandate','mandatory','mandolin','manger','mangle','mango','mangy',
  'manhandle','manhole','manhood','manhunt','manicotti','manicure','manifesto','manila','mankind','manlike',
  'manliness','manly','manmade','manned','mannish','manor','manpower','mantis','mantra','manual','many','map',
  'marathon','marauding','marbled','marbles','marbling','march','mardi','margarine','margarita','margin','marigold',
  'marina','marine','marital','maritime','marlin','marmalade','maroon','married','marrow','marry','marshland',
  'marshy','marsupial','marvelous','marxism','mascot','masculine','mashed','mashing','massager','masses','massive',
  'mastiff','matador','matchbook','matchbox','matcher','matching','matchless','material','maternal','maternity',
  'math','mating','matriarch','matrimony','matrix','matron','matted','matter','maturely','maturing','maturity',
  'mauve','maverick','maximize','maximum','maybe','mayday','mayflower','moaner','moaning','mobile','mobility',
  'mobilize','mobster','mocha','mocker','mockup','modified','modify','modular','modulator','module','moisten',
  'moistness','moisture','molar','molasses','mold','molecular','molecule','molehill','mollusk','mom','monastery',
  'monday','monetary','monetize','moneybags','moneyless','moneywise','mongoose','mongrel','monitor','monkhood',
  'monogamy','monogram','monologue','monopoly','monorail','monotone','monotype','monoxide','monsieur','monsoon',
  'monstrous','monthly','monument','moocher','moodiness','moody','mooing','moonbeam','mooned','moonlight','moonlike',
  'moonlit','moonrise','moonscape','moonshine','moonstone','moonwalk','mop','morale','morality','morally','morbidity',
  'morbidly','morphine','morphing','morse','mortality','mortally','mortician','mortified','mortify','mortuary',
  'mosaic','mossy','most','mothball','mothproof','motion','motivate','motivator','motive','motocross','motor','motto',
  'mountable','mountain','mounted','mounting','mourner','mournful','mouse','mousiness','moustache','mousy','mouth',
  'movable','move','movie','moving','mower','mowing','much','muck','mud','mug','mulberry','mulch','mule','mulled',
  'mullets','multiple','multiply','multitask','multitude','mumble','mumbling','mumbo','mummified','mummify','mummy',
  'mumps','munchkin','mundane','municipal','muppet','mural','murkiness','murky','murmuring','muscular','museum',
  'mushily','mushiness','mushroom','mushy','music','musket','muskiness','musky','mustang','mustard','muster',
  'mustiness','musty','mutable','mutate','mutation','mute','mutilated','mutilator','mutiny','mutt','mutual','muzzle',
  'myself','myspace','mystified','mystify','myth','nacho','nag','nail','name','naming','nanny','nanometer','nape',
  'napkin','napped','napping','nappy','narrow','nastily','nastiness','national','native','nativity','natural',
  'nature','naturist','nautical','navigate','navigator','navy','nearby','nearest','nearly','nearness','neatly',
  'neatness','nebula','nebulizer','nectar','negate','negation','negative','neglector','negligee','negligent',
  'negotiate','nemeses','nemesis','neon','nephew','nerd','nervous','nervy','nest','net','neurology','neuron',
  'neurosis','neurotic','neuter','neutron','never','next','nibble','nickname','nicotine','niece','nifty','nimble',
  'nimbly','nineteen','ninetieth','ninja','nintendo','ninth','nuclear','nuclei','nucleus','nugget','nullify','number',
  'numbing','numbly','numbness','numeral','numerate','numerator','numeric','numerous','nuptials','nursery','nursing',
  'nurture','nutcase','nutlike','nutmeg','nutrient','nutshell','nuttiness','nutty','nuzzle','nylon','oaf','oak',
  'oasis','oat','obedience','obedient','obituary','object','obligate','obliged','oblivion','oblivious','oblong',
  'obnoxious','oboe','obscure','obscurity','observant','observer','observing','obsessed','obsession','obsessive',
  'obsolete','obstacle','obstinate','obstruct','obtain','obtrusive','obtuse','obvious','occultist','occupancy',
  'occupant','occupier','occupy','ocean','ocelot','octagon','octane','october','octopus','ogle','oil','oink',
  'ointment','okay','old','olive','olympics','omega','omen','ominous','omission','omit','omnivore','onboard',
  'oncoming','ongoing','onion','online','onlooker','only','onscreen','onset','onshore','onslaught','onstage','onto',
  'onward','onyx','oops','ooze','oozy','opacity','opal','open','operable','operate','operating','operation',
  'operative','operator','opium','opossum','opponent','oppose','opposing','opposite','oppressed','oppressor','opt',
  'opulently','osmosis','other','otter','ouch','ought','ounce','outage','outback','outbid','outboard','outbound',
  'outbreak','outburst','outcast','outclass','outcome','outdated','outdoors','outer','outfield','outfit','outflank',
  'outgoing','outgrow','outhouse','outing','outlast','outlet','outline','outlook','outlying','outmatch','outmost',
  'outnumber','outplayed','outpost','outpour','output','outrage','outrank','outreach','outright','outscore','outsell',
  'outshine','outshoot','outsider','outskirts','outsmart','outsource','outspoken','outtakes','outthink','outward',
  'outweigh','outwit','oval','ovary','oven','overact','overall','overarch','overbid','overbill','overbite',
  'overblown','overboard','overbook','overbuilt','overcast','overcoat','overcome','overcook','overcrowd','overdraft',
  'overdrawn','overdress','overdrive','overdue','overeager','overeater','overexert','overfed','overfeed','overfill',
  'overflow','overfull','overgrown','overhand','overhang','overhaul','overhead','overhear','overheat','overhung',
  'overjoyed','overkill','overlabor','overlaid','overlap','overlay','overload','overlook','overlord','overlying',
  'overnight','overpass','overpay','overplant','overplay','overpower','overprice','overrate','overreach','overreact',
  'override','overripe','overrule','overrun','overshoot','overshot','oversight','oversized','oversleep','oversold',
  'overspend','overstate','overstay','overstep','overstock','overstuff','oversweet','overtake','overthrow','overtime',
  'overtly','overtone','overture','overturn','overuse','overvalue','overview','overwrite','owl','oxford','oxidant',
  'oxidation','oxidize','oxidizing','oxygen','oxymoron','oyster','ozone','paced','pacemaker','pacific','pacifier',
  'pacifism','pacifist','pacify','padded','padding','paddle','paddling','padlock','pagan','pager','paging','pajamas',
  'palace','palatable','palm','palpable','palpitate','paltry','pampered','pamperer','pampers','pamphlet','panama',
  'pancake','pancreas','panda','pandemic','pang','panhandle','panic','panning','panorama','panoramic','panther',
  'pantomime','pantry','pants','pantyhose','paparazzi','papaya','paper','paprika','papyrus','parabola','parachute',
  'parade','paradox','paragraph','parakeet','paralegal','paralyses','paralysis','paralyze','paramedic','parameter',
  'paramount','parasail','parasite','parasitic','parcel','parched','parchment','pardon','parish','parka','parking',
  'parkway','parlor','parmesan','parole','parrot','parsley','parsnip','partake','parted','parting','partition',
  'partly','partner','partridge','party','passable','passably','passage','passcode','passenger','passerby','passing',
  'passion','passive','passivism','passover','passport','password','pasta','pasted','pastel','pastime','pastor',
  'pastrami','pasture','pasty','patchwork','patchy','paternal','paternity','path','patience','patient','patio',
  'patriarch','patriot','patrol','patronage','patronize','pauper','pavement','paver','pavestone','pavilion','paving',
  'pawing','payable','payback','paycheck','payday','payee','payer','paying','payment','payphone','payroll','pebble',
  'pebbly','pecan','pectin','peculiar','peddling','pediatric','pedicure','pedigree','pedometer','pegboard','pelican',
  'pellet','pelt','pelvis','penalize','penalty','pencil','pendant','pending','penholder','penknife','pennant',
  'penniless','penny','penpal','pension','pentagon','pentagram','pep','perceive','percent','perch','percolate',
  'perennial','perfected','perfectly','perfume','periscope','perish','perjurer','perjury','perkiness','perky','perm',
  'peroxide','perpetual','perplexed','persecute','persevere','persuaded','persuader','pesky','peso','pessimism',
  'pessimist','pester','pesticide','petal','petite','petition','petri','petroleum','petted','petticoat','pettiness',
  'petty','petunia','phantom','phobia','phoenix','phonebook','phoney','phonics','phoniness','phony','phosphate',
  'photo','phrase','phrasing','placard','placate','placidly','plank','planner','plant','plasma','plaster','plastic',
  'plated','platform','plating','platinum','platonic','platter','platypus','plausible','plausibly','playable',
  'playback','player','playful','playgroup','playhouse','playing','playlist','playmaker','playmate','playoff',
  'playpen','playroom','playset','plaything','playtime','plaza','pleading','pleat','pledge','plentiful','plenty',
  'plethora','plexiglas','pliable','plod','plop','plot','plow','ploy','pluck','plug','plunder','plunging','plural',
  'plus','plutonium','plywood','poach','pod','poem','poet','pogo','pointed','pointer','pointing','pointless','pointy',
  'poise','poison','poker','poking','polar','police','policy','polio','polish','politely','polka','polo','polyester',
  'polygon','polygraph','polymer','poncho','pond','pony','popcorn','pope','poplar','popper','poppy','popsicle',
  'populace','popular','populate','porcupine','pork','porous','porridge','portable','portal','portfolio','porthole',
  'portion','portly','portside','poser','posh','posing','possible','possibly','possum','postage','postal','postbox',
  'postcard','posted','poster','posting','postnasal','posture','postwar','pouch','pounce','pouncing','pound',
  'pouring','pout','powdered','powdering','powdery','power','powwow','pox','praising','prance','prancing','pranker',
  'prankish','prankster','prayer','praying','preacher','preaching','preachy','preamble','precinct','precise',
  'precision','precook','precut','predator','predefine','predict','preface','prefix','preflight','preformed',
  'pregame','pregnancy','pregnant','preheated','prelaunch','prelaw','prelude','premiere','premises','premium',
  'prenatal','preoccupy','preorder','prepaid','prepay','preplan','preppy','preschool','prescribe','preseason',
  'preset','preshow','president','presoak','press','presume','presuming','preteen','pretended','pretender','pretense',
  'pretext','pretty','pretzel','prevail','prevalent','prevent','preview','previous','prewar','prewashed','prideful',
  'pried','primal','primarily','primary','primate','primer','primp','princess','print','prior','prism','prison',
  'prissy','pristine','privacy','private','privatize','prize','proactive','probable','probably','probation','probe',
  'probing','probiotic','problem','procedure','process','proclaim','procreate','procurer','prodigal','prodigy',
  'produce','product','profane','profanity','professed','professor','profile','profound','profusely','progeny',
  'prognosis','program','progress','projector','prologue','prolonged','promenade','prominent','promoter','promotion',
  'prompter','promptly','prone','prong','pronounce','pronto','proofing','proofread','proofs','propeller','properly',
  'property','proponent','proposal','propose','props','prorate','protector','protegee','proton','prototype',
  'protozoan','protract','protrude','proud','provable','proved','proven','provided','provider','providing','province',
  'proving','provoke','provoking','provolone','prowess','prowler','prowling','proximity','proxy','prozac','prude',
  'prudishly','prune','pruning','pry','psychic','public','publisher','pucker','pueblo','pug','pull','pulmonary',
  'pulp','pulsate','pulse','pulverize','puma','pumice','pummel','punch','punctual','punctuate','punctured','pungent',
  'punisher','punk','pupil','puppet','puppy','purchase','pureblood','purebred','purely','pureness','purgatory',
  'purge','purging','purifier','purify','purist','puritan','purity','purple','purplish','purposely','purr','purse',
  'pursuable','pursuant','pursuit','purveyor','pushcart','pushchair','pusher','pushiness','pushing','pushover',
  'pushpin','pushup','pushy','putdown','putt','puzzle','puzzling','pyramid','pyromania','python','quack','quadrant',
  'quail','quaintly','quake','quaking','qualified','qualifier','qualify','quality','qualm','quantum','quarrel',
  'quarry','quartered','quarterly','quarters','quartet','quench','query','quicken','quickly','quickness','quicksand',
  'quickstep','quiet','quill','quilt','quintet','quintuple','quirk','quit','quiver','quizzical','quotable',
  'quotation','quote','rabid','race','racing','racism','rack','racoon','radar','radial','radiance','radiantly',
  'radiated','radiation','radiator','radio','radish','raffle','raft','rage','ragged','raging','ragweed','raider',
  'railcar','railing','railroad','railway','raisin','rake','raking','rally','ramble','rambling','ramp','ramrod',
  'ranch','rancidity','random','ranged','ranger','ranging','ranked','ranking','ransack','ranting','rants','rare',
  'rarity','rascal','rash','rasping','ravage','raven','ravine','raving','ravioli','ravishing','reabsorb','reach',
  'reacquire','reaction','reactive','reactor','reaffirm','ream','reanalyze','reappear','reapply','reappoint',
  'reapprove','rearrange','rearview','reason','reassign','reassure','reattach','reawake','rebalance','rebate','rebel',
  'rebirth','reboot','reborn','rebound','rebuff','rebuild','rebuilt','reburial','rebuttal','recall','recant',
  'recapture','recast','recede','recent','recess','recharger','recipient','recital','recite','reckless','reclaim',
  'recliner','reclining','recluse','reclusive','recognize','recoil','recollect','recolor','reconcile','reconfirm',
  'reconvene','recopy','record','recount','recoup','recovery','recreate','rectal','rectangle','rectified','rectify',
  'recycled','recycler','recycling','reemerge','reenact','reenter','reentry','reexamine','referable','referee',
  'reference','refill','refinance','refined','refinery','refining','refinish','reflected','reflector','reflex',
  'reflux','refocus','refold','reforest','reformat','reformed','reformer','reformist','refract','refrain','refreeze',
  'refresh','refried','refueling','refund','refurbish','refurnish','refusal','refuse','refusing','refutable','refute',
  'regain','regalia','regally','reggae','regime','region','register','registrar','registry','regress','regretful',
  'regroup','regular','regulate','regulator','rehab','reheat','rehire','rehydrate','reimburse','reissue','reiterate',
  'rejoice','rejoicing','rejoin','rekindle','relapse','relapsing','relatable','related','relation','relative','relax',
  'relay','relearn','release','relenting','reliable','reliably','reliance','reliant','relic','relieve','relieving',
  'relight','relish','relive','reload','relocate','relock','reluctant','rely','remake','remark','remarry','rematch',
  'remedial','remedy','remember','reminder','remindful','remission','remix','remnant','remodeler','remold','remorse',
  'remote','removable','removal','removed','remover','removing','rename','renderer','rendering','rendition',
  'renegade','renewable','renewably','renewal','renewed','renounce','renovate','renovator','rentable','rental',
  'rented','renter','reoccupy','reoccur','reopen','reorder','repackage','repacking','repaint','repair','repave',
  'repaying','repayment','repeal','repeated','repeater','repent','rephrase','replace','replay','replica','reply',
  'reporter','repose','repossess','repost','repressed','reprimand','reprint','reprise','reproach','reprocess',
  'reproduce','reprogram','reps','reptile','reptilian','repugnant','repulsion','repulsive','repurpose','reputable',
  'reputably','request','require','requisite','reroute','rerun','resale','resample','rescuer','reseal','research',
  'reselect','reseller','resemble','resend','resent','reset','reshape','reshoot','reshuffle','residence','residency',
  'resident','residual','residue','resigned','resilient','resistant','resisting','resize','resolute','resolved',
  'resonant','resonate','resort','resource','respect','resubmit','result','resume','resupply','resurface','resurrect',
  'retail','retainer','retaining','retake','retaliate','retention','rethink','retinal','retired','retiree','retiring',
  'retold','retool','retorted','retouch','retrace','retract','retrain','retread','retreat','retrial','retrieval',
  'retriever','retry','return','retying','retype','reunion','reunite','reusable','reuse','reveal','reveler','revenge',
  'revenue','reverb','revered','reverence','reverend','reversal','reverse','reversing','reversion','revert',
  'revisable','revise','revision','revisit','revivable','revival','reviver','reviving','revocable','revoke','revolt',
  'revolver','revolving','reward','rewash','rewind','rewire','reword','rework','rewrap','rewrite','rhyme','ribbon',
  'ribcage','rice','riches','richly','richness','rickety','ricotta','riddance','ridden','ride','riding','rifling',
  'rift','rigging','rigid','rigor','rimless','rimmed','rind','rink','rinse','rinsing','riot','ripcord','ripeness',
  'ripening','ripping','ripple','rippling','riptide','rise','rising','risk','risotto','ritalin','ritzy','rival',
  'riverbank','riverbed','riverboat','riverside','riveter','riveting','roamer','roaming','roast','robbing','robe',
  'robin','robotics','robust','rockband','rocker','rocket','rockfish','rockiness','rocking','rocklike','rockslide',
  'rockstar','rocky','rogue','roman','romp','rope','roping','roster','rosy','rotten','rotting','rotunda','roulette',
  'rounding','roundish','roundness','roundup','roundworm','routine','routing','rover','roving','royal','rubbed',
  'rubber','rubbing','rubble','rubdown','ruby','ruckus','rudder','rug','ruined','rule','rumble','rumbling','rummage',
  'rumor','runaround','rundown','runner','running','runny','runt','runway','rupture','rural','ruse','rush','rust',
  'rut','sabbath','sabotage','sacrament','sacred','sacrifice','sadden','saddlebag','saddled','saddling','sadly',
  'sadness','safari','safeguard','safehouse','safely','safeness','saffron','saga','sage','sagging','saggy','said',
  'saint','sake','salad','salami','salaried','salary','saline','salon','saloon','salsa','salt','salutary','salute',
  'salvage','salvaging','salvation','same','sample','sampling','sanction','sanctity','sanctuary','sandal','sandbag',
  'sandbank','sandbar','sandblast','sandbox','sanded','sandfish','sanding','sandlot','sandpaper','sandpit',
  'sandstone','sandstorm','sandworm','sandy','sanitary','sanitizer','sank','santa','sapling','sappiness','sappy',
  'sarcasm','sarcastic','sardine','sash','sasquatch','sassy','satchel','satiable','satin','satirical','satisfied',
  'satisfy','saturate','saturday','sauciness','saucy','sauna','savage','savanna','saved','savings','savior','savor',
  'saxophone','say','scabbed','scabby','scalded','scalding','scale','scaling','scallion','scallop','scalping','scam',
  'scandal','scanner','scanning','scant','scapegoat','scarce','scarcity','scarecrow','scared','scarf','scarily',
  'scariness','scarring','scary','scavenger','scenic','schedule','schematic','scheme','scheming','schilling',
  'schnapps','scholar','science','scientist','scion','scoff','scolding','scone','scoop','scooter','scope','scorch',
  'scorebook','scorecard','scored','scoreless','scorer','scoring','scorn','scorpion','scotch','scoundrel','scoured',
  'scouring','scouting','scouts','scowling','scrabble','scraggly','scrambled','scrambler','scrap','scratch','scrawny',
  'screen','scribble','scribe','scribing','scrimmage','script','scroll','scrooge','scrounger','scrubbed','scrubber',
  'scruffy','scrunch','scrutiny','scuba','scuff','sculptor','sculpture','scurvy','scuttle','secluded','secluding',
  'seclusion','second','secrecy','secret','sectional','sector','secular','securely','security','sedan','sedate',
  'sedation','sedative','sediment','seduce','seducing','segment','seismic','seizing','seldom','selected','selection',
  'selective','selector','self','seltzer','semantic','semester','semicolon','semifinal','seminar','semisoft',
  'semisweet','senate','senator','send','senior','senorita','sensation','sensitive','sensitize','sensually',
  'sensuous','sepia','september','septic','septum','sequel','sequence','sequester','series','sermon','serotonin',
  'serpent','serrated','serve','service','serving','sesame','sessions','setback','setting','settle','settling',
  'setup','sevenfold','seventeen','seventh','seventy','severity','shabby','shack','shaded','shadily','shadiness',
  'shading','shadow','shady','shaft','shakable','shakily','shakiness','shaking','shaky','shale','shallot','shallow',
  'shame','shampoo','shamrock','shank','shanty','shape','shaping','share','sharpener','sharper','sharpie','sharply',
  'sharpness','shawl','sheath','shed','sheep','sheet','shelf','shell','shelter','shelve','shelving','sherry','shield',
  'shifter','shifting','shiftless','shifty','shimmer','shimmy','shindig','shine','shingle','shininess','shining',
  'shiny','ship','shirt','shivering','shock','shone','shoplift','shopper','shopping','shoptalk','shore','shortage',
  'shortcake','shortcut','shorten','shorter','shorthand','shortlist','shortly','shortness','shorts','shortwave',
  'shorty','shout','shove','showbiz','showcase','showdown','shower','showgirl','showing','showman','shown','showoff',
  'showpiece','showplace','showroom','showy','shrank','shrapnel','shredder','shredding','shrewdly','shriek','shrill',
  'shrimp','shrine','shrink','shrivel','shrouded','shrubbery','shrubs','shrug','shrunk','shucking','shudder',
  'shuffle','shuffling','shun','shush','shut','shy','siamese','siberian','sibling','siding','sierra','siesta','sift',
  'sighing','silenced','silencer','silent','silica','silicon','silk','silliness','silly','silo','silt','silver',
  'similarly','simile','simmering','simple','simplify','simply','sincere','sincerity','singer','singing','single',
  'singular','sinister','sinless','sinner','sinuous','sip','siren','sister','sitcom','sitter','sitting','situated',
  'situation','sixfold','sixteen','sixth','sixties','sixtieth','sixtyfold','sizable','sizably','size','sizing',
  'sizzle','sizzling','skater','skating','skedaddle','skeletal','skeleton','skeptic','sketch','skewed','skewer',
  'skid','skied','skier','skies','skiing','skilled','skillet','skillful','skimmed','skimmer','skimming','skimpily',
  'skincare','skinhead','skinless','skinning','skinny','skintight','skipper','skipping','skirmish','skirt','skittle',
  'skydiver','skylight','skyline','skype','skyrocket','skyward','slab','slacked','slacker','slacking','slackness',
  'slacks','slain','slam','slander','slang','slapping','slapstick','slashed','slashing','slate','slather','slaw',
  'sled','sleek','sleep','sleet','sleeve','slept','sliceable','sliced','slicer','slicing','slick','slider',
  'slideshow','sliding','slighted','slighting','slightly','slimness','slimy','slinging','slingshot','slinky','slip',
  'slit','sliver','slobbery','slogan','sloped','sloping','sloppily','sloppy','slot','slouching','slouchy','sludge',
  'slug','slum','slurp','slush','sly','small','smartly','smartness','smasher','smashing','smashup','smell','smelting',
  'smile','smilingly','smirk','smite','smith','smitten','smock','smog','smoked','smokeless','smokiness','smoking',
  'smoky','smolder','smooth','smother','smudge','smudgy','smuggler','smuggling','smugly','smugness','snack','snagged',
  'snaking','snap','snare','snarl','snazzy','sneak','sneer','sneeze','sneezing','snide','sniff','snippet','snipping',
  'snitch','snooper','snooze','snore','snoring','snorkel','snort','snout','snowbird','snowboard','snowbound',
  'snowcap','snowdrift','snowdrop','snowfall','snowfield','snowflake','snowiness','snowless','snowman','snowplow',
  'snowshoe','snowstorm','snowsuit','snowy','snub','snuff','snuggle','snugly','snugness','speak','spearfish',
  'spearhead','spearman','spearmint','species','specimen','specked','speckled','specks','spectacle','spectator',
  'spectrum','speculate','speech','speed','spellbind','speller','spelling','spendable','spender','spending','spent',
  'spew','sphere','spherical','sphinx','spider','spied','spiffy','spill','spilt','spinach','spinal','spindle',
  'spinner','spinning','spinout','spinster','spiny','spiral','spirited','spiritism','spirits','spiritual','splashed',
  'splashing','splashy','splatter','spleen','splendid','splendor','splice','splicing','splinter','splotchy','splurge',
  'spoilage','spoiled','spoiler','spoiling','spoils','spoken','spokesman','sponge','spongy','sponsor','spoof',
  'spookily','spooky','spool','spoon','spore','sporting','sports','sporty','spotless','spotlight','spotted','spotter',
  'spotting','spotty','spousal','spouse','spout','sprain','sprang','sprawl','spray','spree','sprig','spring',
  'sprinkled','sprinkler','sprint','sprite','sprout','spruce','sprung','spry','spud','spur','sputter','spyglass',
  'squabble','squad','squall','squander','squash','squatted','squatter','squatting','squeak','squealer','squealing',
  'squeamish','squeegee','squeeze','squeezing','squid','squiggle','squiggly','squint','squire','squirt','squishier',
  'squishy','stability','stabilize','stable','stack','stadium','staff','stage','staging','stagnant','stagnate',
  'stainable','stained','staining','stainless','stalemate','staleness','stalling','stallion','stamina','stammer',
  'stamp','stand','stank','staple','stapling','starboard','starch','stardom','stardust','starfish','stargazer',
  'staring','stark','starless','starlet','starlight','starlit','starring','starry','starship','starter','starting',
  'startle','startling','startup','starved','starving','stash','state','static','statistic','statue','stature',
  'status','statute','statutory','staunch','stays','steadfast','steadier','steadily','steadying','steam','steed',
  'steep','steerable','steering','steersman','stegosaur','stellar','stem','stench','stencil','step','stereo',
  'sterile','sterility','sterilize','sterling','sternness','sternum','stew','stick','stiffen','stiffly','stiffness',
  'stifle','stifling','stillness','stilt','stimulant','stimulate','stimuli','stimulus','stinger','stingily',
  'stinging','stingray','stingy','stinking','stinky','stipend','stipulate','stir','stitch','stock','stoic','stoke',
  'stole','stomp','stonewall','stoneware','stonework','stoning','stony','stood','stooge','stool','stoop','stoplight',
  'stoppable','stoppage','stopped','stopper','stopping','stopwatch','storable','storage','storeroom','storewide',
  'storm','stout','stove','stowaway','stowing','straddle','straggler','strained','strainer','straining','strangely',
  'stranger','strangle','strategic','strategy','stratus','straw','stray','streak','stream','street','strength',
  'strenuous','strep','stress','stretch','strewn','stricken','strict','stride','strife','strike','striking','strive',
  'striving','strobe','strode','stroller','strongbox','strongly','strongman','struck','structure','strudel',
  'struggle','strum','strung','strut','stubbed','stubble','stubbly','stubborn','stucco','stuck','student','studied',
  'studio','study','stuffed','stuffing','stuffy','stumble','stumbling','stump','stung','stunned','stunner','stunning',
  'stunt','stupor','sturdily','sturdy','styling','stylishly','stylist','stylized','stylus','suave','subarctic',
  'subatomic','subdivide','subdued','subduing','subfloor','subgroup','subheader','subject','sublease','sublet',
  'sublevel','sublime','submarine','submerge','submersed','submitter','subpanel','subpar','subplot','subprime',
  'subscribe','subscript','subsector','subside','subsiding','subsidize','subsidy','subsoil','subsonic','substance',
  'subsystem','subtext','subtitle','subtly','subtotal','subtract','subtype','suburb','subway','subwoofer','subzero',
  'succulent','such','suction','sudden','sudoku','suds','sufferer','suffering','suffice','suffix','suffocate',
  'suffrage','sugar','suggest','suing','suitable','suitably','suitcase','suitor','sulfate','sulfide','sulfite',
  'sulfur','sulk','sullen','sulphate','sulphuric','sultry','superbowl','superglue','superhero','superior','superjet',
  'superman','supermom','supernova','supervise','supper','supplier','supply','support','supremacy','supreme',
  'surcharge','surely','sureness','surface','surfacing','surfboard','surfer','surgery','surgical','surging','surname',
  'surpass','surplus','surprise','surreal','surrender','surrogate','surround','survey','survival','survive',
  'surviving','survivor','sushi','suspect','suspend','suspense','sustained','sustainer','swab','swaddling','swagger',
  'swampland','swan','swapping','swarm','sway','swear','sweat','sweep','swell','swept','swerve','swifter','swiftly',
  'swiftness','swimmable','swimmer','swimming','swimsuit','swimwear','swinger','swinging','swipe','swirl','switch',
  'swivel','swizzle','swooned','swoop','swoosh','swore','sworn','swung','sycamore','sympathy','symphonic','symphony',
  'symptom','synapse','syndrome','synergy','synopses','synopsis','synthesis','synthetic','syrup','system','tabasco',
  'tabby','tableful','tables','tablet','tableware','tabloid','tackiness','tacking','tackle','tackling','tacky','taco',
  'tactful','tactical','tactics','tactile','tactless','tadpole','taekwondo','tag','tainted','take','taking','talcum',
  'talisman','tall','talon','tamale','tameness','tamer','tamper','tank','tanned','tannery','tanning','tantrum',
  'tapeless','tapered','tapering','tapestry','tapioca','tapping','taps','tarantula','target','tarmac','tarnish',
  'tarot','tartar','tartly','tartness','task','tassel','taste','tastiness','tasting','tasty','tattered','tattle',
  'tattling','tattoo','taunt','tavern','thank','that','thaw','theater','theatrics','thee','theft','theme','theology',
  'theorize','thermal','thermos','thesaurus','these','thesis','thespian','thicken','thicket','thickness','thieving',
  'thievish','thigh','thimble','thing','think','thinly','thinner','thinness','thinning','thirstily','thirsting',
  'thirsty','thirteen','thirty','thong','thorn','those','thousand','thrash','thread','threaten','threefold','thrift',
  'thrill','thrive','thriving','throat','throbbing','throng','throttle','throwaway','throwback','thrower','throwing',
  'thud','thumb','thumping','thursday','thus','thwarting','thyself','tiara','tibia','tidal','tidbit','tidiness',
  'tidings','tidy','tiger','tighten','tightly','tightness','tightrope','tightwad','tigress','tile','tiling','till',
  'tilt','timid','timing','timothy','tinderbox','tinfoil','tingle','tingling','tingly','tinker','tinkling','tinsel',
  'tinsmith','tint','tinwork','tiny','tipoff','tipped','tipper','tipping','tiptoeing','tiptop','tiring','tissue',
  'trace','tracing','track','traction','tractor','trade','trading','tradition','traffic','tragedy','trailing',
  'trailside','train','traitor','trance','tranquil','transfer','transform','translate','transpire','transport',
  'transpose','trapdoor','trapeze','trapezoid','trapped','trapper','trapping','traps','trash','travel','traverse',
  'travesty','tray','treachery','treading','treadmill','treason','treat','treble','tree','trekker','tremble',
  'trembling','tremor','trench','trend','trespass','triage','trial','triangle','tribesman','tribunal','tribune',
  'tributary','tribute','triceps','trickery','trickily','tricking','trickle','trickster','tricky','tricolor',
  'tricycle','trident','tried','trifle','trifocals','trillion','trilogy','trimester','trimmer','trimming','trimness',
  'trinity','trio','tripod','tripping','triumph','trivial','trodden','trolling','trombone','trophy','tropical',
  'tropics','trouble','troubling','trough','trousers','trout','trowel','truce','truck','truffle','trump','trunks',
  'trustable','trustee','trustful','trusting','trustless','truth','try','tubby','tubeless','tubular','tucking',
  'tuesday','tug','tuition','tulip','tumble','tumbling','tummy','turban','turbine','turbofan','turbojet','turbulent',
  'turf','turkey','turmoil','turret','turtle','tusk','tutor','tutu','tux','tweak','tweed','tweet','tweezers','twelve',
  'twentieth','twenty','twerp','twice','twiddle','twiddling','twig','twilight','twine','twins','twirl','twistable',
  'twisted','twister','twisting','twisty','twitch','twitter','tycoon','tying','tyke','udder','ultimate','ultimatum',
  'ultra','umbilical','umbrella','umpire','unabashed','unable','unadorned','unadvised','unafraid','unaired',
  'unaligned','unaltered','unarmored','unashamed','unaudited','unawake','unaware','unbaked','unbalance','unbeaten',
  'unbend','unbent','unbiased','unbitten','unblended','unblessed','unblock','unbolted','unbounded','unboxed',
  'unbraided','unbridle','unbroken','unbuckled','unbundle','unburned','unbutton','uncanny','uncapped','uncaring',
  'uncertain','unchain','unchanged','uncharted','uncheck','uncivil','unclad','unclaimed','unclamped','unclasp',
  'uncle','unclip','uncloak','unclog','unclothed','uncoated','uncoiled','uncolored','uncombed','uncommon','uncooked',
  'uncork','uncorrupt','uncounted','uncouple','uncouth','uncover','uncross','uncrown','uncrushed','uncured',
  'uncurious','uncurled','uncut','undamaged','undated','undaunted','undead','undecided','undefined','underage',
  'underarm','undercoat','undercook','undercut','underdog','underdone','underfed','underfeed','underfoot','undergo',
  'undergrad','underhand','underline','underling','undermine','undermost','underpaid','underpass','underpay',
  'underrate','undertake','undertone','undertook','undertow','underuse','underwear','underwent','underwire',
  'undesired','undiluted','undivided','undocked','undoing','undone','undrafted','undress','undrilled','undusted',
  'undying','unearned','unearth','unease','uneasily','uneasy','uneatable','uneaten','unedited','unelected','unending',
  'unengaged','unenvied','unequal','unethical','uneven','unexpired','unexposed','unfailing','unfair','unfasten',
  'unfazed','unfeeling','unfiled','unfilled','unfitted','unfitting','unfixable','unfixed','unflawed','unfocused',
  'unfold','unfounded','unframed','unfreeze','unfrosted','unfrozen','unfunded','unglazed','ungloved','unglue',
  'ungodly','ungraded','ungreased','unguarded','unguided','unhappily','unhappy','unharmed','unhealthy','unheard',
  'unhearing','unheated','unhelpful','unhidden','unhinge','unhitched','unholy','unhook','unicorn','unicycle',
  'unified','unifier','uniformed','uniformly','unify','unimpeded','uninjured','uninstall','uninsured','uninvited',
  'union','uniquely','unisexual','unison','unissued','unit','universal','universe','unjustly','unkempt','unkind',
  'unknotted','unknowing','unknown','unlaced','unlatch','unlawful','unleaded','unlearned','unleash','unless',
  'unleveled','unlighted','unlikable','unlimited','unlined','unlinked','unlisted','unlit','unlivable','unloaded',
  'unloader','unlocked','unlocking','unlovable','unloved','unlovely','unloving','unluckily','unlucky','unmade',
  'unmanaged','unmanned','unmapped','unmarked','unmasked','unmasking','unmatched','unmindful','unmixable','unmixed',
  'unmolded','unmoral','unmovable','unmoved','unmoving','unnamable','unnamed','unnatural','unneeded','unnerve',
  'unnerving','unnoticed','unopened','unopposed','unpack','unpadded','unpaid','unpainted','unpaired','unpaved',
  'unpeeled','unpicked','unpiloted','unpinned','unplanned','unplanted','unpleased','unpledged','unplowed','unplug',
  'unpopular','unproven','unquote','unranked','unrated','unraveled','unreached','unread','unreal','unreeling',
  'unrefined','unrelated','unrented','unrest','unretired','unrevised','unrigged','unripe','unrivaled','unroasted',
  'unrobed','unroll','unruffled','unruly','unrushed','unsaddle','unsafe','unsaid','unsalted','unsaved','unsavory',
  'unscathed','unscented','unscrew','unsealed','unseated','unsecured','unseeing','unseemly','unseen','unselect',
  'unselfish','unsent','unsettled','unshackle','unshaken','unshaved','unshaven','unsheathe','unshipped','unsightly',
  'unsigned','unskilled','unsliced','unsmooth','unsnap','unsocial','unsoiled','unsold','unsolved','unsorted',
  'unspoiled','unspoken','unstable','unstaffed','unstamped','unsteady','unsterile','unstirred','unstitch','unstopped',
  'unstuck','unstuffed','unstylish','unsubtle','unsubtly','unsuited','unsure','unsworn','untagged','untainted',
  'untaken','untamed','untangled','untapped','untaxed','unthawed','unthread','untidy','untie','until','untimed',
  'untimely','untitled','untoasted','untold','untouched','untracked','untrained','untreated','untried','untrimmed',
  'untrue','untruth','unturned','untwist','untying','unusable','unused','unusual','unvalued','unvaried','unvarying',
  'unveiled','unveiling','unvented','unviable','unvisited','unvocal','unwanted','unwarlike','unwary','unwashed',
  'unwatched','unweave','unwed','unwelcome','unwell','unwieldy','unwilling','unwind','unwired','unwitting',
  'unwomanly','unworldly','unworn','unworried','unworthy','unwound','unwoven','unwrapped','unwritten','unzip',
  'upbeat','upchuck','upcoming','upcountry','update','upfront','upgrade','upheaval','upheld','uphill','uphold',
  'uplifted','uplifting','upload','upon','upper','upright','uprising','upriver','uproar','uproot','upscale','upside',
  'upstage','upstairs','upstart','upstate','upstream','upstroke','upswing','uptake','uptight','uptown','upturned',
  'upward','upwind','uranium','urban','urchin','urethane','urgency','urgent','urging','urologist','urology','usable',
  'usage','useable','used','uselessly','user','usher','usual','utensil','utility','utilize','utmost','utopia','utter',
  'vacancy','vacant','vacate','vacation','vagabond','vagrancy','vagrantly','vaguely','vagueness','valiant','valid',
  'valium','valley','valuables','value','vanilla','vanish','vanity','vanquish','vantage','vaporizer','variable',
  'variably','varied','variety','various','varmint','varnish','varsity','varying','vascular','vaseline','vastly',
  'vastness','veal','vegan','veggie','vehicular','velcro','velocity','velvet','vendetta','vending','vendor',
  'veneering','vengeful','venomous','ventricle','venture','venue','venus','verbalize','verbally','verbose','verdict',
  'verify','verse','version','versus','vertebrae','vertical','vertigo','very','vessel','vest','veteran','veto',
  'vexingly','viability','viable','vibes','vice','vicinity','victory','video','viewable','viewer','viewing',
  'viewless','viewpoint','vigorous','village','villain','vindicate','vineyard','vintage','violate','violation',
  'violator','violet','violin','viper','viral','virtual','virtuous','virus','visa','viscosity','viscous','viselike',
  'visible','visibly','vision','visiting','visitor','visor','vista','vitality','vitalize','vitally','vitamins',
  'vivacious','vividly','vividness','vixen','vocalist','vocalize','vocally','vocation','voice','voicing','void',
  'volatile','volley','voltage','volumes','voter','voting','voucher','vowed','vowel','voyage','wackiness','wad',
  'wafer','waffle','waged','wager','wages','waggle','wagon','wake','waking','walk','walmart','walnut','walrus',
  'waltz','wand','wannabe','wanted','wanting','wasabi','washable','washbasin','washboard','washbowl','washcloth',
  'washday','washed','washer','washhouse','washing','washout','washroom','washstand','washtub','wasp','wasting',
  'watch','water','waviness','waving','wavy','whacking','whacky','wham','wharf','wheat','whenever','whiff',
  'whimsical','whinny','whiny','whisking','whoever','whole','whomever','whoopee','whooping','whoops','why','wick',
  'widely','widen','widget','widow','width','wieldable','wielder','wife','wifi','wikipedia','wildcard','wildcat',
  'wilder','wildfire','wildfowl','wildland','wildlife','wildly','wildness','willed','willfully','willing','willow',
  'willpower','wilt','wimp','wince','wincing','wind','wing','winking','winner','winnings','winter','wipe','wired',
  'wireless','wiring','wiry','wisdom','wise','wish','wisplike','wispy','wistful','wizard','wobble','wobbling',
  'wobbly','wok','wolf','wolverine','womanhood','womankind','womanless','womanlike','womanly','womb','woof','wooing',
  'wool','woozy','word','work','worried','worrier','worrisome','worry','worsening','worshiper','worst','wound',
  'woven','wow','wrangle','wrath','wreath','wreckage','wrecker','wrecking','wrench','wriggle','wriggly','wrinkle',
  'wrinkly','wrist','writing','written','wrongdoer','wronged','wrongful','wrongly','wrongness','wrought','xbox',
  'xerox','yahoo','yam','yanking','yapping','yard','yarn','yeah','yearbook','yearling','yearly','yearning','yeast',
  'yelling','yelp','yen','yesterday','yiddish','yield','yin','yippee','yodel','yoga','yogurt','yonder','yoyo','yummy',
  'zap','zealous','zebra','zen','zeppelin','zero','zestfully','zesty','zigzagged','zipfile','zipping','zippy','zips',
  'zit','zodiac','zombie','zone','zoning','zookeeper','zoologist','zoology','zoom'
];

// Entropy, summed across all 4 formats below (an attacker sweeping doesn't
// know which format a given code used, so total search space is the sum of
// every format's keyspace, not just the largest one):
//   3 * (7772^2 * 9000) + 7772^3 = 2,100,367,331,648 ~= 2^40.9
// The previous 62-word/2-digit version totaled 2^20.3 — 62^2*90 (x3
// formats) + 62^3. crypto.randomInt() throughout, not Math.random() (V8's
// xorshift128+ — not a CSPRNG, and its internal state is recoverable from a
// modest number of observed outputs) and not
// crypto.randomBytes(n) % CODE_WORDLIST.length (introduces modulo bias
// whenever the list length isn't a power of two — 7772 isn't, neither was
// the previous 62). crypto.randomInt is uniform over its range by
// construction, no bias correction needed.
function code() {
  const p = () => CODE_WORDLIST[crypto.randomInt(CODE_WORDLIST.length)];
  const nn = () => crypto.randomInt(1000, 10000); // 4 digits, 1000-9999
  // A few different shapes instead of always "word-word-NN" — every
  // auto-generated code looking visually identical made them blur together
  // for anyone juggling a few open rooms at once.
  const formats = [
    () => `${p()}-${p()}-${nn()}`,
    () => `${p()}-${nn()}-${p()}`,
    () => `${nn()}-${p()}-${p()}`,
    () => `${p()}-${p()}-${p()}`,
  ];
  return formats[crypto.randomInt(formats.length)]();
}

setInterval(() => {
  const now = Date.now();
  for (const [k,r] of rooms) {
    // Anon Link rooms (r.persistent) are meant to be an ongoing channel
    // between two specific people and are deliberately exempt from the
    // usual 24hr/4-day inactivity TTL — they only ever go away via an
    // explicit revoke (/api/revoke-link) or Close & erase. Otherwise the
    // whole point of a "permanent room" (reopen it weeks later, still
    // there) breaks the first time both people go quiet for a few days.
    if (r.persistent) continue;
    const ttl = r.isNamed ? NAMED_ROOM_TTL : ONE_TIME_ROOM_TTL;
    if (now - r.lastActivity > ttl) { destroyRoom(k); console.log(`Room ${logCode(k)} expired`); }
  }
}, ROOM_EXPIRY_SWEEP_MS);

// Server-side enforcement for disappearing-message timers. Previously, the
// countdown (startDeleteTimer/startReceiveDeleteTimer in index.html) only
// ever controlled what each person's own screen showed — nothing told the
// server to actually delete the message when that countdown finished, so
// its ciphertext kept sitting in room.msgs indefinitely (until the
// 100-message cap or the room's own TTL caught up with it), even after
// neither person could see it anymore. That contradicted the Privacy
// Policy's claim that a disappearing message is "delete[d] from the server
// as soon as its timer expires" — this sweep is what makes that true.
//
// msg.readAt and room.deleteTimer are both already server-held state, the
// same anchor point both the sender's and receiver's local countdowns use
// (the sender's timer starts once the peer's read receipt lands; the
// receiver's starts on their own read) — so this doesn't depend on either
// client staying open, unlike the purely client-side version it backs up.
// A message that's never read never starts its countdown here either,
// exactly matching the behavior it's reinforcing rather than replacing:
// the client-side timers still drive the immediate on-screen countdown/
// removal UX; this is the guarantee that the deletion actually happens
// even if a client's own timer never gets the chance to run (app closed,
// backgrounded and throttled, etc). Reuses the exact same deleted/
// deletionSeq fields as the manual "delete for everyone" path, so it flows
// through the existing /api/poll sync mechanism with no client changes.
setInterval(() => {
  const now = Date.now();
  for (const [roomCode, room] of rooms) {
    if (!room.deleteTimer) continue;
    let changed = false;
    for (const msg of room.msgs) {
      if (msg.type !== 'message' || msg.deleted || !msg.readAt) continue;
      // Only messages sent at or after the timer's CURRENT setting took
      // effect are ever in scope — see deleteTimerSetAt above. Without this
      // guard, turning on (or changing) the timer applied it retroactively
      // to every already-read message in the room's history, deleting
      // conversation that predates the setting entirely; this makes it
      // match the expected "only affects what happens from now on" behavior.
      if (msg.ts < (room.deleteTimerSetAt || 0)) continue;
      if (now - msg.readAt >= room.deleteTimer * 1000) {
        deleteRoomMsgContent(room, msg);
        changed = true;
      }
    }
    if (changed) publishInboxRoom(roomCode, 'deletion');
  }
}, 5000);

function res200(res, data) {
  res.writeHead(200, { 'Content-Type':'application/json', 'Cache-Control': res.getHeader('Cache-Control') || 'no-cache' });
  res.end(JSON.stringify(data));
}
function resErr(res, msg, status=400) {
  res.writeHead(status, { 'Content-Type':'application/json' });
  res.end(JSON.stringify({ error: msg }));
}
// No body, no Content-Type — used where the response itself must not leak
// which of several outcomes actually happened (see /api/leave).
function res204(res) {
  res.writeHead(204);
  res.end();
}

function computeETag(buf) {
  return '"' + crypto.createHash('sha1').update(buf).digest('hex') + '"';
}

// The HTML shell (index.html, install.html, and the SPA catch-all below that
// serves index.html's content for any unrecognized path like /join/<code>)
// is the one thing here that actually needs a cache directive — the entire
// app, including encryptMsg/decryptMsg, lives in that one inline <script>,
// so a stale copy of this file IS a stale copy of the app. With no explicit
// caching headers at all, a browser is permitted to apply heuristic caching
// (RFC 9111 §4.2.2) to a plain navigation (a bookmark, history, back/
// forward) even though a manual reload wouldn't hit that path — no-cache
// (not no-store) forces revalidation with the server before ever reusing a
// cached copy, without losing the copy entirely, so a 304 stays cheap. The
// ETag below is what makes that revalidation actually cost a 304 instead of
// a full refetch. Deliberately not applied to any other static asset —
// there's nothing else here whose staleness has security consequences.
function sendHtmlShell(req, res, data) {
  const etag = computeETag(data);
  const cacheControl = res.getHeader('Cache-Control') || 'no-cache';
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'Cache-Control': cacheControl, 'ETag': etag });
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': cacheControl, 'ETag': etag });
  res.end(data);
}

function serveStatic(req, res) {
  let url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  // Explicit route, ahead of the SPA catch-all below — without this, a
  // request for /robots.txt falls through to the readFile-miss branch and
  // silently gets served index.html instead (wrong content, wrong
  // Content-Type). No sitemap.xml yet — not worth it until there's more
  // than one real page.
  if (url === '/robots.txt') {
    const body = 'User-agent: *\nAllow: /\n';
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
    return;
  }
  // Extension-less route for the install page — without this, a request for
  // "/install" (no ".html") misses the readFile below, falls through to the
  // SPA catch-all, and silently serves the main app instead of install.html.
  if (url === '/install') url = '/install.html';
  if (url === '/admin') url = '/admin.html';
  if (!url.startsWith('/') || url.includes('..')) { res.writeHead(403); res.end(); return; }
  fs.readFile(path.join(__dirname,'../client',url), (err,data) => {
    if (err) {
      fs.readFile(path.join(__dirname,'../client/index.html'), (e,d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        sendHtmlShell(req, res, d);
      }); return;
    }
    if (url === '/index.html' || url === '/install.html') {
      sendHtmlShell(req, res, data);
      return;
    }
    const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.mp4':'video/mp4'};
    // Explicit Content-Length (rather than letting Node fall back to
    // chunked transfer-encoding on HTTP/1.1) matters specifically for
    // og:image — link-preview crawlers (WhatsApp's included) are known to
    // silently drop an image asset served without one, even though a
    // normal browser or curl handles chunked fine.
    const contentType = url === '/.well-known/apple-app-site-association'
      ? 'application/json'
      : (t[path.extname(url)] || 'text/plain');
    res.writeHead(200,{'Content-Type':contentType,'Content-Length':Buffer.byteLength(data)}); res.end(data);
  });
}

// Per-endpoint request body caps. /api/send is the one legitimate exception
// — MAX_MESSAGE_CONTENT_BYTES above (19MB) already measured the real
// worst-case: a full 10MB file attachment, base64'd, JSON-wrapped, AES-GCM
// encrypted, then base64'd again by encryptMsg, comes out to ~17.78MB.
// BODY_LIMIT_SEND has to stay at least that big plus the small JSON wrapper
// (code, token, msgId — a few hundred bytes) or real attachments would get
// rejected; 20MB (unchanged from the previous single blanket cap) keeps
// that same ~1.2MB+ of headroom without moving the actual ceiling.
//
// Every other endpoint here only ever carries a few hundred bytes of JSON —
// a code, a token, a name, a msgId, at most a PushSubscription. Measured a
// realistic PushSubscription body (real FCM endpoint shape, real-length
// p256dh/auth keys) at ~455 bytes, and a padded worst-case within
// validatePushSubscription's own 255-char field caps at ~1067 bytes — both
// comfortably under the shared 8KB default, so push-subscribe doesn't get
// its own larger allowance. Giving every one of these endpoints the same
// 20MB ceiling /api/send needs was the actual bug: message-COUNT limits
// don't stop a flood of requests to a small endpoint from each individually
// buffering up to that ceiling before any handler or auth check ever runs.
const BODY_LIMIT_SEND = 20 * 1024 * 1024;
const BODY_LIMIT_DEFAULT = 8 * 1024;
function bodyLimitFor(pathname) {
  if (pathname === '/api/account/register' || pathname === '/api/account/sync') return 1100 * 1024;
  return pathname === '/api/send' ? BODY_LIMIT_SEND : BODY_LIMIT_DEFAULT;
}

// Migrated from valuted.in to vaultlix.com. Both domains need to stay
// attached to this same Railway service (don't remove valuted.in from
// Railway's domain settings) — the redirect below only fires if a request
// for the old domain actually reaches this process.
const OLD_DOMAINS = new Set(['valuted.in', 'www.valuted.in']);
const NEW_DOMAIN = 'vaultlix.com';

// Applied to every single response — static, API, redirect, error alike —
// by setting them before any of this request's other handling runs.
// res.setHeader() here is what makes that possible: Node merges these into
// whatever headers object a later res.writeHead() call passes, rather than
// one replacing the other, so no individual response path (serveStatic,
// res200/resErr/res204, the redirects below) has to remember to add them
// itself. script-src/default-src are deliberately NOT in this set — the
// client is one large inline <script> with inline onclick handlers
// throughout, and a real CSP would break the entire app; de-inlining is a
// separate task. frame-ancestors doesn't touch script execution, so it's
// the one CSP directive in scope here.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  // camera/microphone MUST stay (self), not () — () disables getUserMedia
  // entirely and breaks every call. geolocation/payment/usb are denied
  // outright since nothing in this app uses them.
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()',
};

const srv = http.createServer((req, res) => {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  const host = (req.headers.host || '').toLowerCase();

  // Send anyone still landing on the old domain — an old bookmark, a
  // previously-shared room link, a home-screen shortcut installed before the
  // move — straight to the new one, already over https, in a single hop.
  // This has to run before the http-to-https upgrade below; otherwise an
  // old-domain http:// request would upgrade to old-domain https:// first
  // and only reach the new domain on a second round trip.
  if (OLD_DOMAINS.has(host)) {
    res.writeHead(301, { Location: `https://${NEW_DOMAIN}${req.url}` });
    res.end();
    return;
  }

  // Railway's edge terminates TLS and forwards decrypted traffic to this
  // process, setting x-forwarded-proto so we can tell which scheme the
  // visitor actually used. Force the upgrade here, and send HSTS once we
  // know a request came in over https so browsers remember to use https for
  // this host next time, even if someone lands on an old http:// link.
  const proto = req.headers['x-forwarded-proto'];
  if (proto === 'http') {
    // Location is built from the fixed canonical domain, not req.headers.host
    // — host is attacker-controlled if an arbitrary Host header ever reaches
    // this service, which would otherwise let it be reflected straight into
    // a redirect target. Same NEW_DOMAIN constant as the old-domain redirect
    // above, so the two can't end up disagreeing on what "canonical" means.
    res.writeHead(301, { Location: `https://${NEW_DOMAIN}${req.url}` });
    res.end();
    return;
  }
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/install' || u.pathname === '/install.html') {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  }
  if (u.pathname === '/admin' || u.pathname === '/admin.html' || u.pathname === '/admin.js' || u.pathname === '/admin.css') {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    res.setHeader('Cache-Control', 'no-store');
  }
  if (!u.pathname.startsWith('/api/')) { serveStatic(req,res); return; }
  // Per-endpoint body cap, not one blanket ceiling — /api/send legitimately
  // carries large attachments (see BODY_LIMIT_SEND below), but giving every
  // other endpoint here that same allowance turned each of them into an
  // independent multi-megabyte memory sink: a flood of tiny-looking requests
  // to e.g. /api/leave or /api/poll could each buffer up to the ceiling
  // before any handler or auth check ever ran, regardless of how small that
  // endpoint's real payload actually is.
  //
  // Enforced DURING accumulation (checked after every chunk, not once after
  // 'end') — checking only at the end is meaningless, since by then the
  // oversized data has already been fully buffered into memory regardless.
  // Chunks are collected into an array and Buffer.concat'd once at the end,
  // rather than the previous `body += d`, which silently coerced every
  // incoming Buffer to a string on each chunk (repeated string
  // reallocation, and `.length` on the result is UTF-16 code units, not the
  // byte count actually received — chunk.length on the raw Buffer is what
  // the cap below actually measures).
  const bodyLimit = bodyLimitFor(u.pathname);
  const chunks = [];
  let received = 0;
  let bodyTooLarge = false;
  req.on('data', chunk => {
    if (bodyTooLarge) return;
    received += chunk.length;
    if (received > bodyLimit) {
      bodyTooLarge = true;
      try { resErr(res, 'Request body too large.', 413); } catch(e) {}
      req.destroy(); // stop reading — do not keep buffering past the cap
      return;
    }
    chunks.push(chunk);
  });
  req.on('end',()=>{
    if (bodyTooLarge) return;
    let d={};
    try { if (chunks.length) d = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch{}
    // api() is async now (password hashing awaits scrypt) but still responds
    // entirely through the res object rather than a return value, so this
    // stays fire-and-forget — just needs a catch so a thrown error (a
    // malformed password field, scrypt failing, etc.) can't crash the
    // process or hang the request with no response ever sent.
    api(u.pathname, req.method, d, u.searchParams, res, clientIp(req), req.headers).catch(err => {
      console.error('API error:', err.message);
      try { resErr(res, 'Internal error.', 500); } catch(e) {}
    });
  });
});

async function api(path, method, d, p, res, ip, headers) {

  if (path === '/api/report' && method === 'POST') {
    if (rateLimited(`safety-report:${ip}`, 5, 60 * 60 * 1000)) return resErr(res, 'Too many reports — try again later.', 429);
    const room = rooms.get(d.code);
    const member = room && typeof d.token === 'string' ? room.members.get(d.token) : null;
    if (!room || !member) return resErr(res, 'This conversation is no longer available.', 403);
    const reasons = new Set(['spam','harassment','threats','sexual','illegal','other']);
    if (!reasons.has(d.reason)) return resErr(res, 'Choose a valid report reason.', 400);
    const details = typeof d.details === 'string' ? d.details.trim().slice(0, 500) : '';
    const includeMessages = d.includeMessages === true;
    const messages = includeMessages && Array.isArray(d.messages) ? d.messages.slice(-5).map(msg => ({
      content: typeof msg.content === 'string' ? msg.content.slice(0, 500) : '',
      isReporter: !!msg.isMe,
      ts: Number.isFinite(msg.ts) ? msg.ts : Date.now(),
    })).filter(msg => msg.content) : [];
    try {
      appendSafetyReport({
        id: crypto.randomUUID(), createdAt: new Date().toISOString(), reason:d.reason, details,
        vaultHash: crypto.createHash('sha256').update(`vaultlix-report-v1\0${d.code}`).digest('hex'),
        reporterHash: crypto.createHash('sha256').update(`vaultlix-reporter-v1\0${d.token}`).digest('hex'),
        messages,
      });
    } catch (error) { console.error('Safety report save failed:', error.message); return resErr(res, 'Report could not be saved.', 503); }
    return res200(res, { ok:true });
  }

  // Native Android can acknowledge an answer before its call-only WebView and
  // encrypted signalling socket have finished their cold start. This stops
  // the caller's ringing timeout immediately; the actual SDP and media setup
  // still begins only after the E2E call-accept arrives below.
  if (path === '/api/native-call/answer' && method === 'POST') {
    if (rateLimited(`native-call-answer:${ip}`, 30, 60 * 1000)) return resErr(res, 'Too many call actions.', 429);
    const callId = typeof d.callId === 'string' ? d.callId.trim() : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
      return resErr(res, 'Invalid call action.', 400);
    }

    let matchedRoom = null;
    for (const room of rooms.values()) {
      if (room.nativeCallId === callId) { matchedRoom = room; break; }
    }
    if (!matchedRoom) return res200(res, { ok: true });

    const wasRinging = matchedRoom.ringingUntil && matchedRoom.ringingUntil > Date.now();
    if (wasRinging) {
      analytics.callsAnswered = (analytics.callsAnswered || 0) + 1;
      trackAggregate('callsAnswered');
    }
    matchedRoom.ringingUntil = 0;
    matchedRoom.activeCall = true;
    matchedRoom.lastActivity = Date.now();

    const calleeToken = matchedRoom.nativeCalleeToken;
    for (const [memberToken] of matchedRoom.members) {
      if (memberToken === calleeToken) continue;
      const callerSockets = new Set([
        nativeCallSignalingSockets.get(memberToken),
        signalingSockets.get(memberToken),
      ]);
      for (const callerSocket of callerSockets) {
        if (callerSocket && callerSocket.readyState === callerSocket.OPEN) {
          try { callerSocket.send(JSON.stringify({ type: 'native-call-answering' })); } catch (e) {}
        }
      }
      break;
    }
    return res200(res, { ok: true });
  }

  // Native Android can reject an incoming call before its WebView/signalling
  // socket has opened. The random server-issued call ID is a short-lived
  // capability scoped to the one currently ringing call; no room code,
  // membership token or E2E material is exposed to this endpoint.
  if (path === '/api/native-call/decline' && method === 'POST') {
    if (rateLimited(`native-call-decline:${ip}`, 30, 60 * 1000)) return resErr(res, 'Too many call actions.', 429);
    const callId = typeof d.callId === 'string' ? d.callId.trim() : '';
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(callId)) {
      return resErr(res, 'Invalid call action.', 400);
    }

    let matchedRoom = null;
    for (const room of rooms.values()) {
      if (room.nativeCallId === callId) { matchedRoom = room; break; }
    }
    // Deliberately return the same result for an expired/already-declined ID:
    // native retries stay idempotent and this is not a call-ID oracle.
    if (!matchedRoom) return res200(res, { ok: true });

    const calleeToken = matchedRoom.nativeCalleeToken;
    markInviteTerminated(matchedRoom, matchedRoom.nativeInviteId);
    matchedRoom.ringingUntil = 0;
    matchedRoom.activeCall = false;
    matchedRoom.nativeCallId = null;
    matchedRoom.nativeCalleeToken = null;
    matchedRoom.lastActivity = Date.now();

    // This control frame contains no message/call content. It is delivered
    // only over the already authenticated socket belonging to the other
    // member of this 1:1 vault. The browser accepts it only while it is the
    // outgoing caller, then stops its local ringtone immediately.
    for (const [memberToken] of matchedRoom.members) {
      if (memberToken === calleeToken) continue;
      // Deliver to both owners when both exist. A stale native incoming-call
      // socket must not prevent the foreground WebView that placed this
      // outgoing call from receiving the terminal state.
      const callerSockets = new Set([
        nativeCallSignalingSockets.get(memberToken),
        signalingSockets.get(memberToken),
      ]);
      for (const callerSocket of callerSockets) {
        if (callerSocket && callerSocket.readyState === callerSocket.OPEN) {
          try { callerSocket.send(JSON.stringify({ type: 'native-call-declined' })); } catch (e) {}
        }
      }
      break;
    }
    return res200(res, { ok: true });
  }

  // The public Vaultlix Private Number is deliberately
  // separate from the random internal accountId. Vault data is an AES-GCM
  // ciphertext produced on the device. The server
  // can authenticate, replace and return that blob, but cannot list its
  // vaults, codenames, room tokens or E2E private keys.
  if (path === '/api/account/private-number' && method === 'POST') {
    if (rateLimited(`private-number:${ip}`, 20, 60 * 60 * 1000)) return resErr(res, 'Too many number requests — try again later.', 429);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok:true, privateNumber:generatePrivateNumber() });
  }

  if (path === '/api/account/register' && method === 'POST') {
    if (rateLimited(`account-register:${ip}`, 5, 60 * 60 * 1000)) return resErr(res, 'Too many registration attempts — try again later.', 429);
    const privateNumber = normalizePrivateNumber(d.privateNumber);
    const displayName = normalizeDisplayName(d.displayName);
    if (!privateNumber || !displayName || !validAccountId(d.accountId) || !validAccountSecret(d.authSecret) ||
        !validAccountSecret(d.recoverySecret) || !validEncryptedField(d.passwordWrap, 4096) ||
        !validEncryptedField(d.recoveryWrap, 4096) || !validEncryptedField(d.bundle, 1024 * 1024)) {
      return resErr(res, 'Invalid account data.', 400);
    }
    const existing = accounts.get(d.accountId);
    const existingNumberOwner = privateNumbers.get(privateNumber);
    // Registration is idempotent for the same authenticated account. Mobile
    // WebViews can lose the first response while their network stack is still
    // warming up; allowing the exact client to repeat the request prevents a
    // successfully-created identity from being reported as a failure.
    if (existing && existingNumberOwner === d.accountId && existing.privateNumber === privateNumber) {
      if (!(await verifyAccountSecret(d.authSecret, existing.authVerifier))) {
        return resErr(res, 'That Vaultlix Private Number is unavailable.', 409);
      }
      const sessionToken = newAccountSession(existing);
      await persistAccount(d.accountId);
      res.setHeader('Cache-Control', 'no-store');
      return res200(res, { ok:true, accountId:d.accountId, ...publicAccount(existing), sessionToken, revision:existing.revision });
    }
    if (existing || existingNumberOwner) return resErr(res, 'That Vaultlix Private Number is unavailable.', 409);
    const account = {
      version: 2, privateNumber, displayName,
      authVerifier: await hashAccountSecret(d.authSecret),
      recoveryVerifier: await hashAccountSecret(d.recoverySecret),
      passwordWrap: d.passwordWrap,
      recoveryWrap: d.recoveryWrap,
      bundle: d.bundle,
      revision: 1,
      createdAt: Date.now(), updatedAt: Date.now(), sessions: [], connectionRequests:[], pushDestinations:[],
    };
    const sessionToken = newAccountSession(account);
    accounts.set(d.accountId, account);
    privateNumbers.set(privateNumber, d.accountId);
    await persistAccount(d.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true, accountId:d.accountId, ...publicAccount(account), sessionToken, revision: account.revision });
  }

  if (path === '/api/account/login' && method === 'POST') {
    if (rateLimited(`account-login:${ip}`, 10, 15 * 60 * 1000)) return resErr(res, 'Too many login attempts — try again later.', 429);
    const found = accountByPrivateNumber(d.privateNumber);
    const account = found?.account || null;
    // Always perform a scrypt check, including for an unknown ID, to avoid a
    // cheap Private-Number-existence timing oracle.
    const verifier = account ? account.authVerifier : DUMMY_ACCOUNT_VERIFIER;
    const valid = await verifyAccountSecret(d.authSecret, verifier);
    if (!account || !valid) return resErr(res, 'Vaultlix Private Number or password is incorrect.', 403);
    const sessionToken = newAccountSession(account);
    await persistAccount(found.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true, accountId:found.accountId, ...publicAccount(account), sessionToken, passwordWrap: account.passwordWrap, bundle: account.bundle, revision: account.revision });
  }

  if (path === '/api/account/recover' && method === 'POST') {
    if (rateLimited(`account-recover:${ip}`, 6, 60 * 60 * 1000)) return resErr(res, 'Too many recovery attempts — try again later.', 429);
    const found = accountByPrivateNumber(d.privateNumber);
    const account = found?.account || null;
    const verifier = account ? account.recoveryVerifier : DUMMY_ACCOUNT_VERIFIER;
    const valid = await verifyAccountSecret(d.recoverySecret, verifier);
    if (!account || !valid) return resErr(res, 'Vaultlix Private Number or recovery code is incorrect.', 403);
    if (!validAccountSecret(d.newAuthSecret) || !validEncryptedField(d.passwordWrap, 4096)) return resErr(res, 'Invalid recovery update.', 400);
    account.authVerifier = await hashAccountSecret(d.newAuthSecret);
    account.passwordWrap = d.passwordWrap;
    account.sessions = [];
    const sessionToken = newAccountSession(account);
    account.updatedAt = Date.now();
    await persistAccount(found.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true, accountId:found.accountId, ...publicAccount(account), sessionToken, recoveryWrap: account.recoveryWrap, bundle: account.bundle, revision: account.revision });
  }

  if (path === '/api/account/recovery-bundle' && method === 'POST') {
    if (rateLimited(`account-recovery-read:${ip}`, 8, 60 * 60 * 1000)) return resErr(res, 'Too many recovery attempts — try again later.', 429);
    const found = accountByPrivateNumber(d.privateNumber);
    const account = found?.account || null;
    const verifier = account ? account.recoveryVerifier : DUMMY_ACCOUNT_VERIFIER;
    const valid = await verifyAccountSecret(d.recoverySecret, verifier);
    if (!account || !valid) return resErr(res, 'Vaultlix Private Number or recovery code is incorrect.', 403);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true, accountId:found.accountId, ...publicAccount(account), recoveryWrap: account.recoveryWrap, bundle: account.bundle, revision: account.revision });
  }

  if (path === '/api/account/profile' && method === 'POST') {
    if (rateLimited(`account-profile:${ip}`, 20, 60 * 60 * 1000)) return resErr(res, 'Too many profile changes — try again later.', 429);
    if (!validAccountId(d.accountId)) return resErr(res, 'Not signed in.', 401);
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your Vaultlix session has expired.', 401);
    const displayName = normalizeDisplayName(d.displayName);
    if (!displayName) return resErr(res, 'Enter a username between 2 and 40 characters.', 400);
    account.displayName = displayName;
    account.updatedAt = Date.now();
    await persistAccount(d.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok:true, displayName });
  }

  if (path === '/api/account/sync' && method === 'POST') {
    if (!validAccountId(d.accountId)) return resErr(res, 'Not signed in.', 401);
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your Vaultlix session has expired.', 401);
    if (!validEncryptedField(d.bundle, 1024 * 1024)) return resErr(res, 'Encrypted conversation index is invalid or too large.', 400);
    if (!Number.isInteger(d.revision) || d.revision !== account.revision) {
      res.setHeader('Cache-Control', 'no-store');
      return resErr(res, 'Conversation index changed on another device. Sign in again to merge it safely.', 409);
    }
    account.bundle = d.bundle;
    account.revision++;
    account.updatedAt = Date.now();
    await persistAccount(d.accountId);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true, revision: account.revision });
  }

  if (path === '/api/account/fetch' && method === 'POST') {
    if (!validAccountId(d.accountId)) return resErr(res, 'Not signed in.', 401);
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your Vaultlix session has expired.', 401);
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true, bundle: account.bundle, revision: account.revision });
  }

  // One authenticated foreground/reconnect catch-up replaces one request per
  // conversation. Room credentials are supplied by the device and validated
  // independently, preserving the account file's no-readable-social-graph
  // property. The response is an invalidation index; changed rooms are then
  // fetched through the existing E2E room sync path.
  if (path === '/api/inbox/sync' && method === 'POST') {
    if (!validAccountId(d.accountId) || !authenticateAccountSession(d.accountId, d.sessionToken)) {
      return resErr(res, 'Your Vaultlix session has expired.', 401);
    }
    if (!Array.isArray(d.conversations) || d.conversations.length > 20) {
      return resErr(res, 'Invalid inbox subscription.', 400);
    }
    const updates = [];
    for (const item of d.conversations) {
      if (!item || typeof item.code !== 'string' || typeof item.token !== 'string') continue;
      const code = item.code.toLowerCase().trim();
      const room = rooms.get(code);
      if (!room) { updates.push({ code, roomGone:true }); continue; }
      if (!room.members.has(item.token)) continue;
      const lastSeq = Number.parseInt(item.lastSeq || 0, 10);
      const lastReceiptSeq = Number.parseInt(item.lastReceiptSeq || 0, 10);
      const lastReactionSeq = Number.parseInt(item.lastReactionSeq || 0, 10);
      const lastDeletionSeq = Number.parseInt(item.lastDeletionSeq || 0, 10);
      const receiptChanged = room.msgs.some(msg => msg.type === 'message' && msg.from === item.token &&
        msg.deliveredAt && (msg.seq > lastReceiptSeq || (msg.readAt && !msg.readReported)));
      const peerMessageChanged = room.msgs.some(msg => msg.seq > lastSeq && !msg.deleted && msg.from !== item.token);
      let typing = false;
      const now = Date.now();
      for (const [token, member] of room.members) {
        if (token !== item.token && member.typing && now - member.typing < 3000) typing = true;
      }
      updates.push({
        code,
        changed: peerMessageChanged || room.reactionSeq > lastReactionSeq ||
          room.deletionSeq > lastDeletionSeq || (room.clearedAt || 0) > Number(item.lastKnownClearedAt || 0) || receiptChanged,
        typing,
      });
    }
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok:true, sequence:inboxSequenceByAccount.get(d.accountId) || 0, updates });
  }

  if (path === '/api/account/logout' && method === 'POST') {
    const account = validAccountId(d.accountId) ? accounts.get(d.accountId) : null;
    if (account && typeof d.sessionToken === 'string') {
      const tokenHash = crypto.createHash('sha256').update(d.sessionToken).digest('hex');
      account.sessions = (account.sessions || []).filter(s => s.tokenHash !== tokenHash);
      await persistAccount(d.accountId);
    }
    return res200(res, { ok: true });
  }

  // Authenticated, account-wide erasure. Removing the record invalidates
  // every session at once and permanently discards the encrypted account
  // bundle and recovery material. Room destruction remains room-token
  // scoped through /api/close so this endpoint cannot become a vault oracle.
  if (path === '/api/account/delete' && method === 'POST') {
    if (rateLimited(`account-delete:${ip}`, 5, 60 * 60 * 1000)) return resErr(res, 'Too many account deletion attempts — try again later.', 429);
    if (!validAccountId(d.accountId)) return resErr(res, 'Not signed in.', 401);
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your Vaultlix session has expired.', 401);
    privateNumbers.delete(account.privateNumber);
    accounts.delete(d.accountId);
    if (postgresEnabled) await postgresStore.deleteAccount(d.accountId); else saveAccounts();
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, { ok: true });
  }

  if (path.startsWith('/api/profile/') && method === 'GET') {
    const found = accountByPrivateNumber(decodeURIComponent(path.slice('/api/profile/'.length)));
    if (!found) return resErr(res, 'Vaultlix Private Number not found.', 404);
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res200(res, { ok:true, profile:publicAccount(found.account) });
  }

  if (path === '/api/connections/request' && method === 'POST') {
    if (rateLimited(`connection-request:${ip}`, 20, 60 * 60 * 1000)) return resErr(res, 'Too many requests — try again later.', 429);
    const sender = authenticateAccountSession(d.accountId, d.sessionToken);
    const recipient = accountByPrivateNumber(d.privateNumber);
    if (!sender) return resErr(res, 'Your session has expired.', 401);
    if (!recipient) return resErr(res, 'Vaultlix Private Number not found.', 404);
    if (recipient.accountId === d.accountId) return resErr(res, 'You cannot request yourself.', 400);
    const now = Date.now();
    recipient.account.connectionRequests = (recipient.account.connectionRequests || []).filter(r => r.expiresAt > now && r.status !== 'rejected').slice(-99);
    const duplicate = recipient.account.connectionRequests.find(r => r.senderAccountId === d.accountId && r.status === 'pending');
    if (duplicate) return res200(res, { ok:true, requestId:duplicate.id, status:'pending' });
    const request = { id:uid(), senderAccountId:d.accountId, senderPrivateNumber:sender.privateNumber, senderDisplayName:sender.displayName, recipientAccountId:recipient.accountId, recipientPrivateNumber:recipient.account.privateNumber, recipientDisplayName:recipient.account.displayName, direction:'incoming', status:'pending', createdAt:now, expiresAt:now + CONNECTION_REQUEST_TTL_MS };
    recipient.account.connectionRequests.push(request);
    sender.connectionRequests = (sender.connectionRequests || []).filter(r => r.expiresAt > now).slice(-99);
    sender.connectionRequests.push({ ...request, direction:'outgoing' });
    await Promise.all([persistAccount(d.accountId), persistAccount(recipient.accountId)]);
    publishInboxAccount(recipient.accountId, 'connection-request');
    const requestPushPayload = JSON.stringify({
      title:'Vaultlix',
      body:`${sender.displayName} sent you a connection request`,
      tag:`connection-request-${request.id}`,
      connectionRequest:true,
    });
    for (const destination of recipient.account.pushDestinations || []) {
      sendMemberPush(destination, requestPushPayload, { urgency:'high', TTL:3600, label:'connection request' });
    }
    return res200(res, { ok:true, requestId:request.id, status:'pending' });
  }

  if (path === '/api/account/native-push-subscribe' && method === 'POST') {
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your session has expired.', 401);
    if (rateLimited(`account-native-push:${d.accountId}`, 20, 60 * 1000)) return resErr(res, 'Too many notification updates.', 429);
    let destination;
    if (d.platform === 'android') {
      const fcmToken = validateFcmToken(d.deviceToken);
      if (!fcmToken) return resErr(res, 'Invalid device token.', 400);
      destination = { platform:'android', fcmToken, updatedAt:Date.now() };
    } else if (d.platform === 'ios') {
      const apnsToken = validateApnsToken(d.deviceToken);
      if (!apnsToken) return resErr(res, 'Invalid device token.', 400);
      if (d.environment !== 'sandbox' && d.environment !== 'production') return resErr(res, 'Invalid APNs environment.', 400);
      destination = { platform:'ios', apnsToken, apnsEnvironment:d.environment, updatedAt:Date.now() };
    } else {
      return resErr(res, 'Invalid native platform.', 400);
    }
    const token = destination.fcmToken || destination.apnsToken;
    account.pushDestinations = (account.pushDestinations || [])
      .filter(item => (item.fcmToken || item.apnsToken) !== token)
      .concat(destination)
      .slice(-10);
    await persistAccount(d.accountId);
    return res200(res, { ok:true });
  }

  if (path === '/api/connections/list' && method === 'POST') {
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your session has expired.', 401);
    const now = Date.now();
    account.connectionRequests = (account.connectionRequests || []).filter(r => r.expiresAt > now);
    return res200(res, { ok:true, requests:account.connectionRequests.map(({senderAccountId, recipientAccountId, ...safe}) => safe) });
  }

  if (path === '/api/connections/respond' && method === 'POST') {
    const account = authenticateAccountSession(d.accountId, d.sessionToken);
    if (!account) return resErr(res, 'Your session has expired.', 401);
    const request = (account.connectionRequests || []).find(r => r.id === d.requestId && r.direction === 'incoming' && r.status === 'pending');
    if (!request) return resErr(res, 'Request is no longer available.', 404);
    if (!['accepted','rejected'].includes(d.action)) return resErr(res, 'Invalid response.', 400);
    request.status = d.action; request.respondedAt = Date.now();
    if (d.action === 'accepted') {
      if (typeof d.inviteUrl !== 'string' || d.inviteUrl.length > 512 || !/^https:\/\/vaultlix\.com\/join\/[a-z0-9-]+(?:#k=[A-Za-z0-9_-]{22})?$/.test(d.inviteUrl)) return resErr(res, 'A secure conversation invitation is required.', 400);
      request.inviteUrl = d.inviteUrl;
    }
    const sender = accounts.get(request.senderAccountId);
    const outgoing = (sender?.connectionRequests || []).find(r => r.id === request.id);
    if (outgoing) { outgoing.status=request.status; outgoing.respondedAt=request.respondedAt; if (request.inviteUrl) outgoing.inviteUrl=request.inviteUrl; }
    await Promise.all([persistAccount(d.accountId), request.senderAccountId ? persistAccount(request.senderAccountId) : Promise.resolve()]);
    publishInboxAccount(request.senderAccountId, 'connection-response');
    return res200(res, { ok:true, status:request.status });
  }

  // POST /api/create
  if (path==='/api/create' && method==='POST') {
    // A short-window abuse limit prevents automated room-creation floods;
    // it is not a per-account or per-device conversation allowance.
    if (rateLimited(`create:${ip}`, 20, 10 * 60 * 1000)) {
      return resErr(res, 'Too many conversations created from this connection — try again in a few minutes.', 429);
    }
    // Hard ceiling on total concurrent rooms, independent of the byte
    // budgets above — even an empty room costs real memory (a Map entry,
    // member records), and unbounded room COUNT is a distinct DoS surface
    // from unbounded room BYTES. Rejected explicitly (clear error, logged)
    // rather than degrading silently in some other way.
    if (rooms.size >= MAX_CONCURRENT_ROOMS) {
      console.warn(`MAX_CONCURRENT_ROOMS (${MAX_CONCURRENT_ROOMS}) reached — rejecting new room creation.`);
      return resErr(res, 'Too many active conversations right now — please try again shortly.', 503);
    }
    // The label used to BE the entire room code, with zero entropy of its
    // own — a guessable word like "family" was the whole credential for a
    // vault that (as a persistent room) never expires. It's now a memorable,
    // non-secret PREFIX only: a full random code() is appended
    // unconditionally, so a named vault gets the exact same ~41-bit floor
    // as an anonymous one — see code()'s own derivation above. Capped at 16
    // (down from 40) now that it's a prefix in front of up to
    // "-word-word-4823" rather than the whole shareable string; 40 would
    // have produced an ~80-character code at the old cap, unusable to read
    // aloud or type by hand.
    const namedLabel = d.namedCode ? d.namedCode.replace(/[^a-z0-9-]/g,'-').slice(0,16) : null;
    const namedCode = namedLabel ? `${namedLabel}-${code()}` : null;
    if (namedCode && rooms.has(namedCode)) return resErr(res,`Conversation "${namedCode}" already exists.`,409);
    const roomCode = namedCode || code();
    const token = uid();
    const name = (d.name||'Stranger').slice(0,24);
    const passwordHash = d.password ? await hashPassword(d.password) : null;
    // Anon Link ("permanent room") rooms are the same room shape as everything
    // else — the only difference is the `persistent` flag, which the TTL
    // sweep and the stale-member eviction logic below both check to exempt
    // it from the usual short-lived-room assumptions.
    const persistent = !!d.persistent;
    const createdAt = Date.now();
    const room = {
      lastActivity: createdAt,
      isNamed: !!namedCode,
      persistent,
      // Set once the second person actually joins — used for the "connected
      // since" indicator on the client, distinct from lastActivity (which
      // moves on every poll/message and wouldn't tell you when the
      // relationship itself started).
      connectedSince: null,
      // Running count of real messages ever sent through this room. Kept
      // separate from room.msgs.length because msgs is trimmed to the last
      // 100 and disappearing messages get deleted out of it entirely — this
      // counter is the only thing that still answers "how many messages
      // have these two exchanged," which the client shows for permanent
      // links as a small trust/investment signal.
      totalMessageCount: 0,
      // Timestamp of the last real message sent through this room (set only
      // in /api/send, unlike lastActivity which also moves on join/poll).
      // Used client-side to answer "has anyone actually said anything today"
      // for the daily nudge, without depending on locally-cached history.
      lastMessageAt: null,
      deleteTimer: parseInt(d.deleteTimer)||0,
      // The moment the CURRENT deleteTimer value took effect — the sweep
      // below only ever considers messages sent at or after this point, so
      // enabling/changing the timer can never retroactively delete anything
      // already in the room. Irrelevant at creation (nothing's been sent
      // yet), but kept consistent with /api/set-timer below.
      deleteTimerSetAt: createdAt,
      passwordHash,
      seq: 0,          // global message sequence counter
      reactionSeq: 0,  // separate counter so reaction updates can be synced like read receipts
      deletionSeq: 0,  // same pattern again, for "delete for everyone" — see /api/delete-message
      members: new Map([[token, { name, pubKey: d.pubKey||null, lastSeen: createdAt, slot:1 }]]),
      msgs: [],        // { seq, id, type, from, name, content, time, ts, deliveredAt, readAt, reactions, reactionSeq }
      byteSize: 0,     // running total of msgs[].content.length — see pushRoomMsg/deleteRoomMsgContent
    };
    rooms.set(roomCode, room);
    try {
      if (postgresEnabled) {
        await postgresStore.createConversation({ id:roomCode, persistent, deleteTimer:room.deleteTimer, createdAt });
        await postgresStore.upsertConversationMember(roomCode, 1, token, room.members.get(token));
      }
    } catch (error) {
      rooms.delete(roomCode);
      throw error;
    }
    if (persistent) analytics.roomsCreatedPermanent++; else analytics.roomsCreatedTemporary++;
    trackAggregate(persistent ? 'vaultsPermanent' : 'vaultsTemporary');
    console.log(`Room created: ${logCode(roomCode)}${persistent ? ' (permanent room)' : ''}`);
    // labelLength tells the client exactly where the user-typed label ends
    // and the appended random suffix begins, so it can render them
    // differently (see revealCode in client/index.html) without having to
    // re-derive the boundary by scanning for hyphens — the label itself can
    // contain one, so that would be ambiguous. null for an anonymous room:
    // the whole code is server-random, nothing to visually distinguish.
    return res200(res, { code: roomCode, token, name, deleteTimer: parseInt(d.deleteTimer)||0, persistent, labelLength: namedLabel ? namedLabel.length : null });
  }

  // POST /api/join
  if (path==='/api/join' && method==='POST') {
    const roomCode = (d.code||'').toLowerCase().trim();
    const room = rooms.get(roomCode);

    // Rejoin with saved token — an existing session token is itself the
    // credential for continued access, so this branch intentionally comes
    // before the password check below. Password re-verification used to
    // apply here too, which silently broke reconnecting to any
    // password-protected room: a page reload never re-sends the password
    // (it isn't kept in memory across a reload), so every reload of one of
    // these rooms was rejected as "Incorrect password" even with a
    // perfectly valid saved session.
    //
    // Deliberately checked (and returned) before the rate limit below: a
    // possessed valid token is already proof of membership, so someone with
    // a flaky connection reloading repeatedly must never be able to lock
    // themselves out of their own room.
    if (d.token && room && room.members.has(d.token)) {
      const m = room.members.get(d.token);
      m.lastSeen = Date.now();
      if (d.pubKey) m.pubKey = d.pubKey;
      // Reconnects are automatic for every locally saved vault. Treating
      // that background housekeeping as vault activity prevents temporary
      // rooms from ever reaching their 24-hour inactivity deadline.
      // peerName rides along now too — without it, a reconnecting client had
      // nothing to show in its header until its first regular poll came
      // back, which meant the raw room code sat there visibly if that poll
      // was even slightly delayed.
      let peerPubKey = null, peerName = null;
      for (const [t,mb] of room.members) if (t!==d.token) { peerPubKey = mb.pubKey; peerName = mb.name; }
      return res200(res, { code: roomCode, token: d.token, name: m.name, isReconnect: true, peerPubKey, peerName, deleteTimer: room.deleteTimer, persistent: !!room.persistent, connectedSince: room.connectedSince || null, totalMessageCount: room.totalMessageCount || 0, lastMessageAt: room.lastMessageAt || 0 });
    }

    // Everything past this point is either a fresh join or a probe for a
    // room that may not even exist — exactly the path that let the ~1.28M
    // vault-code keyspace get swept in ~20 minutes at 1000 req/s with no
    // limit at all here before this. 20/10min is generous enough that a
    // real user opening a few vaults never notices it (this app's own
    // 5-open-rooms cap is the practical ceiling anyway), but it turns that
    // sweep into something computationally infeasible. Deliberately NOT
    // tightened further — mobile carriers (India especially) put many real
    // users behind one shared CGNAT IP, and this has to stay generous
    // enough not to collide with that.
    if (rateLimited(`join:${ip}`, 20, 10 * 60 * 1000)) {
      return resErr(res, 'Too many join attempts from this connection — try again in a few minutes.', 429);
    }

    // "Room not found" and "incorrect password" are deliberately the same
    // response — status, body, and timing — rather than distinguished the
    // way "room is full" still is below. Both mean "the credentials you
    // supplied don't open a vault"; a legitimate user who mistyped either
    // one gets the same actionable advice either way, and merging them
    // closes the enumeration oracle a differing response would otherwise
    // hand an attacker. "Room is full" stays distinct: it's only reachable
    // once the password check has already passed, so revealing it to a
    // legitimate third party is worth more than the marginal oracle it
    // leaves (the code-space itself is 2^41, already the real defense
    // against brute-forcing which codes exist at all).
    if (!room) {
      await dummyPasswordDerivation();
      return resErr(res,'Incorrect code or password.',403);
    }

    if (room.passwordHash && !(await verifyPassword(d.password, room.passwordHash))) return resErr(res,'Incorrect code or password.',403);

    // Only evict a member for staleness when the room is actually full and
    // doing so is what makes room for this new joiner — NOT as a blanket
    // sweep on every fresh-join call regardless of whether anyone needs to
    // be displaced. That unconditional sweep (with only a 30-SECOND
    // threshold) was a real bug: a member who's simply offline for a bit —
    // screen locked, phone put away, briefly backgrounded — is not "gone".
    // Rooms here live up to 4 days specifically so a real reconnect can
    // happen much later than 30 seconds from now. Evicting them the moment
    // some unrelated fresh-join request landed during that gap silently and
    // permanently broke their session: with their entry gone from
    // room.members, their own next reconnect attempt would no longer be
    // recognized either, forcing THEM through this same fresh-join path,
    // minting a brand-new token their already-running client never knew to
    // save over its old (now-orphaned) one — which is exactly the "header
    // stuck on the room code, history never loads, never self-corrects"
    // symptom reported. Only pruning when the room is genuinely at capacity
    // (2/2) removes the false-eviction case entirely; the 5-minute
    // threshold (up from 30 seconds) is still well short of the room's own
    // multi-day TTL but generous enough that it won't trip on a normal
    // reconnect gap.
    // Standing links (room.persistent) are only ever shared with the one
    // specific person the relationship is with — there's no risk of a 3rd
    // party contending for the slot the way a one-off code passed around a
    // subreddit thread might see. So a much longer stale window is safe
    // here, and safer overall: the whole promise of a link that "doesn't
    // expire" would ring hollow if the other side's membership could still
    // get silently evicted after a routine 5-minute gap.
    const STALE_MEMBER_MS = room.persistent ? 30 * 24 * 60 * 60 * 1000 : 5 * 60 * 1000;
    if (room.members.size >= 2) {
      const staleThreshold = Date.now() - STALE_MEMBER_MS;
      for (const [t, m] of room.members) {
        if (m.lastSeen < staleThreshold) {
          room.members.delete(t);
          if (postgresEnabled && m.slot) await postgresStore.deleteConversationMember(roomCode, m.slot);
        }
      }
    }
    if (room.members.size >= 2) return resErr(res,'Conversation is full.',403);
    const token = uid();
    const name = (d.name||'Stranger').slice(0,24);
    const usedSlots = new Set([...room.members.values()].map(member => member.slot).filter(Boolean));
    const slot = usedSlots.has(1) ? 2 : 1;
    const member = { name, pubKey: d.pubKey||null, lastSeen: Date.now(), slot };
    if (postgresEnabled) await postgresStore.upsertConversationMember(roomCode, slot, token, member);
    room.members.set(token, member);
    analytics.joins = (analytics.joins || 0) + 1;
    trackAggregate('joins');
    room.lastActivity = Date.now();
    // First time the second person actually shows up on a permanent room —
    // this is the "connected since" the client shows, not creation time.
    if (room.persistent && !room.connectedSince && room.members.size >= 2) {
      room.connectedSince = Date.now();
    }

    // System message — tagged with `from` so the poll filter (which already
    // excludes a caller's own messages) also excludes this one for the
    // joiner themselves. Without it, system messages had no sender at all,
    // so the "X joined" announcement got echoed back to X's own client too
    // — confusing since the app had just told them "You're X" a moment
    // earlier. The other member still gets it normally, which is the whole
    // point of the message.
    const joinedEventId = uid();
    pushRoomMsg(room, { seq: ++room.seq, id: joinedEventId, type:'system', content:`${name} joined`, ts: Date.now(), from: token });
    publishInboxRoom(roomCode, 'membership', { excludeToken:token });

    // The creator may have shared the invitation and moved on to another
    // vault (or locked the phone) while waiting. Notify that existing member
    // exactly when a fresh peer accepts a temporary vault. Reconnects return
    // from the earlier token branch, so they cannot produce duplicate alerts.
    const acceptedPayload = buildTemporaryVaultAcceptedPayload({
      persistent: room.persistent,
      code: roomCode,
      peerName: name,
      eventId: joinedEventId,
    });
    if (acceptedPayload) {
      for (const [memberToken, member] of room.members) {
        if (memberToken !== token && hasPushDestination(member)) {
          sendMemberPush(member, acceptedPayload, { urgency: 'high', TTL: 3600, label: 'vault accepted' });
        }
      }
    }

    // peerName included here too now, same as the reconnect branch above —
    // if a client ever IS legitimately forced through this fresh-join path
    // (room password changed, genuinely new participant, etc.) its header
    // can resolve immediately instead of waiting on the first live poll.
    let peerPubKey = null, peerName = null;
    for (const [t,mb] of room.members) if (t!==token) { peerPubKey = mb.pubKey; peerName = mb.name; }
    console.log(`Member joined ${logCode(roomCode)}`);
    return res200(res, { code: roomCode, token, name, peerPubKey, peerName, deleteTimer: room.deleteTimer, persistent: !!room.persistent, connectedSince: room.connectedSince || null, totalMessageCount: room.totalMessageCount || 0, lastMessageAt: room.lastMessageAt || 0 });
  }

  // POST /api/send
  if (path==='/api/send' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    // Rate-limited by token (the authenticated sender), not IP — two people
    // in the same room can legitimately share an IP (same NAT/network), and
    // punishing by IP would hit the wrong person. 20 messages per 10
    // seconds is far above normal typing speed but stops a flooding script;
    // there was no limit of any kind here before this.
    if (rateLimited(`send:${d.token}`, 20, 10 * 1000)) {
      return resErr(res, 'Sending too fast — slow down a moment.', 429);
    }
    // d.content had no size check at all — the 100-message trim below is a
    // COUNT cap, not a byte cap, so 100 full-size file attachments could
    // still be ~1.78GB in one room (see MAX_MESSAGE_CONTENT_BYTES's
    // derivation above for how that number was actually measured, not
    // guessed). This is the per-message half of the fix; the cumulative
    // per-room byte budget below is the other half.
    if (typeof d.content !== 'string' || d.content.length > MAX_MESSAGE_CONTENT_BYTES) {
      return resErr(res, 'Message too large.', 413);
    }
    const m = room.members.get(d.token);
    m.lastSeen = Date.now();
    room.lastActivity = Date.now();
    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0')+':'+now.getMinutes().toString().padStart(2,'0');
    // Use the client-supplied id when present so the sender's DOM element
    // (rendered optimistically before this request completes) never needs
    // to be renamed. That rename had a race: if a read-receipt for this
    // message arrived on the sender's next poll before the /api/send
    // response was processed, the receipt lookup (by real id) missed the
    // element (still tagged with the temp id), the blue tick never applied,
    // and the disappearing-message timer — which only starts from inside
    // that same lookup — never fired. A client-chosen id removes the window.
    const clientMsgId = typeof d.msgId === 'string' ? d.msgId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64) : '';
    const msgId = clientMsgId || uid();
    const seq = room.seq + 1;
    // viewOnce travels as a plain top-level field (client/index.html's
    // sendFileMessage/sendAlbumMessage) alongside the encrypted content —
    // this server can't see inside that encrypted payload, so without this
    // it has no way to verify a /api/view-once-opened request actually
    // targets a view-once message rather than an ordinary one.
    // pushRoomMsg applies both the count cap (last 100, seq numbers never
    // reset) and the byte budget in one place now — see its definition.
    // Lowered from 300: applies regardless of whether disappearing-message
    // timers are on, so even a room without them retains less on the server.
    const message = { seq, id: msgId, type:'message', from: d.token, name: m.name, content: d.content, viewOnce: !!d.viewOnce, time, ts: Date.now(), deliveredAt: null, readAt: null, reactions: {}, reactionSeq: 0 };
    if (postgresEnabled) await postgresStore.appendEncryptedMessage(d.code, d.token, message);
    room.seq = seq;
    pushRoomMsg(room, message);
    publishInboxRoom(d.code, 'message', { excludeToken:d.token });
    room.totalMessageCount = (room.totalMessageCount || 0) + 1;
    room.lastMessageAt = Date.now();
    analytics.messagesRelayed = (analytics.messagesRelayed || 0) + 1;
    trackAggregate('messages');

    // Best-effort push notification to the peer if they've subscribed. The
    // server can't decrypt d.content (E2E), so the payload is deliberately
    // generic — only the sender's already-plaintext display name goes out,
    // never message content. Fire-and-forget: a slow/failed push must never
    // delay the send response.
    // Encrypted call-history records use the same durable message stream so
    // they appear on both devices, but they must not masquerade as a new chat
    // message after hang-up. The flag affects notification fan-out only; the
    // encrypted record, inbox event, receipts and catch-up behavior are kept.
    if (d.suppressNotification !== true) for (const [t, mb] of room.members) {
      if (t !== d.token && hasPushDestination(mb)) {
        // tag used to just be d.code (the room code) — same tag for every
        // message in the room, combined with sw.js's renotify:true. That
        // combination hits a long-standing, still-unresolved Chrome bug
        // (reported repeatedly against exactly this tag+renotify pattern,
        // e.g. github.com/OneSignal/OneSignal-Website-SDK/issues/857):
        // once one notification with a given tag has been shown and the
        // person hasn't interacted with it, every later push that reuses
        // that same tag silently updates the existing notification in the
        // tray instead of re-alerting — no vibration, no sound, no
        // heads-up — even though renotify:true is supposed to force a
        // fresh alert. That's exactly "ignore one notification, then stop
        // getting notified at all" even though the pushes are still
        // arriving and being delivered to the tray. Making the tag unique
        // per message means Chrome never treats a new push as "replacing"
        // an old one, so it can't hit that silent-update path — every
        // message reliably alerts on its own.
        // code + msgId ride along (still no message content — E2E holds)
        // so the service worker can report delivery straight from the push
        // handler itself, the moment the notification is shown, rather
        // than only when/if the page's own poll loop happens to run — see
        // the mark-delivered fetch in sw.js's push listener.
        const payload = JSON.stringify({ title: 'Vaultlix', body: `New message from ${m.name}`, tag: `${d.code}-${msgId}`, code: d.code, msgId });
        // urgency:'high' asks the push service (Apple/Google's relay) to wake the
        // device promptly instead of batching/deferring — matters most on iOS,
        // which is more aggressive about delaying "normal" priority pushes to a
        // locked, idle device. TTL is a 60s delivery window if the device is briefly
        // unreachable (e.g. no signal), after which the push service drops it.
        sendMemberPush(mb, payload, { urgency: 'high', TTL: 60, label: 'message' });

        // Same reasoning as the call-invite retry below: iOS web push has
        // meaningfully lower single-attempt delivery odds than Android (no
        // equivalent of native apps' high-priority push tier is available
        // to web apps at all). deliveredAt is the real signal that the
        // recipient's client actually picked this message up via poll —
        // if it's still unset a few seconds later, the first push likely
        // never landed, so send one more. Scoped to this exact msgId, not
        // "any new activity," so a message that already arrived fine never
        // gets a redundant second buzz.
        setTimeout(() => {
          const rec = room.msgs.find(x => x.id === msgId);
          if (!rec || rec.deliveredAt) return; // delivered (or trimmed/gone) already
          // Native alert pushes cannot run app code on receipt to mark this
          // message delivered while the phone is locked. APNs/FCM provider
          // acceptance is therefore the delivery signal; retrying solely
          // because deliveredAt is unset creates a guaranteed second alert.
          // Browser Web Push can acknowledge from sw.js, so it keeps this
          // guarded retry for genuinely missed deliveries.
          if (mb.apnsToken || mb.fcmToken) return;
          if (!hasPushDestination(mb)) return; // already known-dead from the first attempt
          sendMemberPush(mb, payload, { urgency: 'high', TTL: 30, label: 'message retry' });
        }, 6000);
      }
    }

    return res200(res, { ok: true, msgId, seq });
  }

  // POST /api/push-subscribe — store this member's Web Push subscription
  if (path==='/api/push-subscribe' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    const validated = validatePushSubscription(d.subscription);
    if (!validated) return resErr(res, 'Invalid push subscription.', 400);
    const m = room.members.get(d.token);
    m.pushSub = validated;
    return res200(res, { ok: true });
  }

  // POST /api/push-unsubscribe — remove every notification destination for
  // this authenticated room member. Account sign-out uses this before its
  // local room token is erased, preventing messages or calls for a signed-out
  // identity from continuing to appear on a shared device.
  if (path==='/api/push-unsubscribe' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    if (rateLimited(`push-unsubscribe:${d.token}`, 20, 60 * 1000)) return resErr(res,'Too many notification updates.',429);
    const m = room.members.get(d.token);
    m.pushSub = null;
    m.fcmToken = null;
    m.apnsToken = null;
    m.apnsEnvironment = null;
    m.voipToken = null;
    m.voipEnvironment = null;
    m.nativeRoomHandle = null;
    return res200(res, { ok: true });
  }

  // POST /api/native-push-subscribe — bind an APNs or FCM device token to an
  // authenticated member of this room. A stolen room code alone is not
  // sufficient; the caller must also present the random member bearer token.
  if (path==='/api/native-push-subscribe' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    if (rateLimited(`native-push:${d.token}`, 10, 60 * 1000)) return resErr(res,'Too many notification registrations.',429);
    const m = room.members.get(d.token);
    if (d.platform === 'android') {
      const deviceToken = validateFcmToken(d.deviceToken);
      if (!deviceToken) return resErr(res,'Invalid device token.',400);
      m.fcmToken = deviceToken;
    } else if (d.platform === 'ios' || !d.platform) {
      const deviceToken = validateApnsToken(d.deviceToken);
      if (!deviceToken) return resErr(res,'Invalid device token.',400);
      if (d.environment !== 'sandbox' && d.environment !== 'production') return resErr(res,'Invalid APNs environment.',400);
      m.apnsToken = deviceToken;
      m.apnsEnvironment = d.environment;
    } else {
      return resErr(res,'Invalid native platform.',400);
    }
    return res200(res, { ok: true });
  }

  // A PushKit token is distinct from the ordinary notification token above.
  if (path==='/api/voip-subscribe' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    if (rateLimited(`voip-push:${d.token}`, 10, 60 * 1000)) return resErr(res,'Too many notification registrations.',429);
    if (!validateVoipToken(d.voipToken)) return resErr(res,'Invalid VoIP token.',400);
    if (d.environment !== 'sandbox' && d.environment !== 'production') return resErr(res,'Invalid APNs environment.',400);
    if (typeof d.roomHandle !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(d.roomHandle)) {
      return resErr(res,'Invalid native conversation handle.',400);
    }
    const m = room.members.get(d.token);
    m.voipToken = d.voipToken.toLowerCase();
    m.voipEnvironment = d.environment;
    m.nativeRoomHandle = d.roomHandle;
    console.log(`VoIP token registered for room ${logCode(d.code)} (${d.environment}).`);
    return res200(res, { ok: true });
  }

  // POST /api/turn-credentials — mints a short-lived Cloudflare TURN
  // credential for an authenticated room member. The long-lived
  // CF_TURN_KEY_API_TOKEN never leaves this server; only the resulting
  // iceServers array (a one-time username/credential pair good for TTL
  // seconds) goes back to the client. Same auth check as every other
  // room-scoped endpoint — a token that isn't in room.members gets nothing.
  if (path==='/api/turn-credentials' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    if (rateLimited(`turn:${d.token}`, 6, 60 * 1000)) return resErr(res,'Too many requests.',429);
    if (!process.env.CF_TURN_KEY_ID || !process.env.CF_TURN_KEY_API_TOKEN) {
      console.error('TURN credentials requested but CF_TURN_KEY_ID/CF_TURN_KEY_API_TOKEN not set.');
      return resErr(res,'Calling is not configured.',503);
    }
    try {
      const turnApiBase = process.env.NODE_ENV === 'test' && process.env.TEST_CF_TURN_API_BASE
        ? process.env.TEST_CF_TURN_API_BASE.replace(/\/$/, '')
        : 'https://rtc.live.cloudflare.com/v1/turn';
      const cfRes = await fetch(
        `${turnApiBase}/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.CF_TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          // 1 hour — long enough for essentially any call, short enough that
          // a leaked credential is worthless soon after. Refresh mid-call via
          // RTCPeerConnection.setConfiguration() rather than issuing longer.
          body: JSON.stringify({ ttl: 3600 }),
        }
      );
      if (!cfRes.ok) {
        console.error('Cloudflare TURN credential request failed:', cfRes.status, await cfRes.text().catch(()=>''));
        return resErr(res,'Could not reach calling service.',502);
      }
      const cfData = await cfRes.json();
      room.lastActivity = Date.now();
      return res200(res, { iceServers: cfData.iceServers });
    } catch (e) {
      console.error('TURN credential request error:', e.message);
      return resErr(res,'Could not reach calling service.',502);
    }
  }

  // POST /api/react — toggle a single-emoji reaction from this member onto a message
  if (path==='/api/react' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId);
    if (!msg) return resErr(res,'Message not found.',404);
    if (!msg.reactions) msg.reactions = {};
    if (d.emoji) msg.reactions[d.token] = String(d.emoji).slice(0,8);
    else delete msg.reactions[d.token];
    msg.reactionSeq = ++room.reactionSeq;
    room.lastActivity = Date.now();
    publishInboxRoom(d.code, 'reaction', { excludeToken:d.token });
    return res200(res, { ok: true });
  }

  // POST /api/delete-message — "delete for me" needs no server involvement
  // at all (purely local removal on the client, since nothing is persisted
  // there beyond msgId/timestamp anyway). This is "delete for everyone":
  // only the original sender may invoke it, and only on a real message (not
  // a system line). Content is stripped rather than the message being
  // spliced out of the array, so seq numbering for anything else in the
  // room is untouched. deletionSeq mirrors reactionSeq's sync pattern —
  // it's what lets an already-open peer session remove the message live via
  // /api/poll's `deletions` list; anyone who hasn't reached its seq yet
  // simply never receives it, since the poll filter below skips deleted
  // messages outright.
  if (path==='/api/delete-message' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId && mm.type === 'message');
    if (!msg) return resErr(res,'Message not found.',404);
    if (msg.from !== d.token) return resErr(res,'Only the sender can delete this for everyone.',403);
    const deletedAt = Date.now();
    const deletionSequence = room.deletionSeq + 1;
    if (postgresEnabled) await postgresStore.deleteEncryptedMessage(d.code, msg.id, deletionSequence, deletedAt, deletedAt + DELETION_TOMBSTONE_TTL_MS);
    deleteRoomMsgContent(room, msg);
    room.lastActivity = Date.now();
    publishInboxRoom(d.code, 'deletion', { excludeToken:d.token });
    return res200(res, { ok: true });
  }

  // POST /api/view-once-opened — the recipient of a view-once photo tells
  // the server they've just seen it, so it disappears from the ORIGINAL
  // SENDER's side too — view-once is a promise to both people, not just
  // "hidden until tapped" on the recipient's end. Reuses the exact same
  // deletion/deletionSeq mechanism as /api/delete-message above, but
  // intentionally does NOT require the caller to be msg.from — the whole
  // point is the recipient, not the sender, triggers this deletion.
  //
  // That "not msg.from" reasoning previously wasn't enforced at all: this
  // never checked msg.viewOnce (so it deleted ANY message by id, view-once
  // or not) and never checked that the caller ISN'T the sender either —
  // any room member could delete any message for everyone, completely
  // bypassing /api/delete-message's sender-only restriction above. Both
  // checks are required now: the message must actually be view-once, and
  // the caller must be the recipient (i.e. NOT msg.from) — the inverse of
  // /api/delete-message's own check just above.
  if (path==='/api/view-once-opened' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId && mm.type === 'message');
    if (!msg) return resErr(res,'Message not found.',404);
    if (msg.viewOnce !== true || msg.from === d.token) return resErr(res,'Not authorized to open this message.',403);
    if (!msg.deleted) {
      const deletedAt = Date.now();
      const deletionSequence = room.deletionSeq + 1;
      if (postgresEnabled) await postgresStore.deleteEncryptedMessage(d.code, msg.id, deletionSequence, deletedAt, deletedAt + DELETION_TOMBSTONE_TTL_MS);
      deleteRoomMsgContent(room, msg);
      room.lastActivity = Date.now();
      publishInboxRoom(d.code, 'deletion', { excludeToken:d.token });
    }
    return res200(res, { ok: true });
  }

  // POST /api/set-timer — change the disappearing-message duration for this
  // room at any point in the conversation, not just at creation. Either
  // member can change it; a system message announces the new setting to
  // both, and the value itself rides the existing deleteTimer field already
  // returned on every /api/poll response, so both clients pick it up within
  // one poll cycle without any extra sync mechanism.
  if (path==='/api/set-timer' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    const m = room.members.get(d.token);
    if (!m) return resErr(res,'Not in conversation.',403);
    const val = parseInt(d.deleteTimer);
    room.deleteTimer = (isNaN(val) || val < 0) ? 0 : val;
    // Anchor point for the sweep below — turning the timer on (or changing
    // its duration) only ever applies to messages sent from this moment
    // forward. Without this, enabling e.g. a 5-minute timer on a room with
    // existing history immediately swept up every already-read message
    // older than 5 minutes on the very next sweep cycle, deleting past
    // conversation that had nothing to do with the setting being turned on
    // just now. Set unconditionally (even when turning the timer OFF) so
    // that if it's re-enabled later, only messages from that later point
    // are ever in scope — never a stale timestamp from an earlier session.
    room.deleteTimerSetAt = Date.now();
    room.lastActivity = Date.now();
    pushRoomMsg(room, {
      seq: ++room.seq, id: uid(), type:'system',
      content: room.deleteTimer
        ? `${m.name} set disappearing messages to ${formatTimerLabel(room.deleteTimer)}`
        : `${m.name} turned off disappearing messages`,
      ts: Date.now(),
    });
    publishInboxRoom(d.code, 'timer', { excludeToken:d.token });
    return res200(res, { ok: true, deleteTimer: room.deleteTimer });
  }

  // POST /api/clear-chat — wipes all message history for this room while
  // leaving the room itself (code, membership, session tokens, and the
  // disappearing-message timer setting) completely untouched. Unlike
  // /api/delete-message ("delete for everyone"), which only lets the
  // original sender remove their own message, this is a joint room action:
  // either member can invoke it, since it clears the shared history both
  // people are looking at, not just their own sent messages. clearedAt is
  // how an already-open session (via /api/poll) learns to wipe its own
  // in-memory history too — a fresh page load needs no such signal, since
  // the now-emptied room.msgs has nothing left in it to bootstrap-fetch back.
  if (path==='/api/clear-chat' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    const m = room.members.get(d.token);
    if (!m) return resErr(res,'Not in conversation.',403);
    room.msgs = [];
    totalByteSize = Math.max(0, totalByteSize - (room.byteSize || 0)); // this room's share is gone too
    room.byteSize = 0; // everything that byte total was tracking is gone with room.msgs
    room.clearedAt = Date.now();
    room.lastActivity = Date.now();
    pushRoomMsg(room, { seq: ++room.seq, id: uid(), type:'system', content:`${m.name} cleared the chat`, ts: Date.now() });
    publishInboxRoom(d.code, 'clear', { excludeToken:d.token });
    return res200(res, { ok: true, clearedAt: room.clearedAt });
  }

  // POST /api/poll — return all messages with seq > clientLastSeq that are
  // not from this user. Used to be a GET with code/token/lastSeq etc. as
  // URL query parameters; moved to POST with a JSON body instead, because a
  // GET request's full URL — including its query string — is exactly what
  // standard infrastructure access logging (Railway's included) tends to
  // capture. That meant the room code and, worse, the actual session token
  // were landing in platform-level logs on every single poll cycle (every
  // 2s, for as long as a room stayed open) — a far bigger exposure than the
  // occasional room code in this app's own console.log lines. A POST body
  // isn't parsed/stored by that same standard access-log layer, so this
  // keeps the same data out of logs going forward without changing
  // anything about who can call it or what it returns.
  if (path==='/api/poll' && method==='POST') {
    const roomCode = d.code;
    const token = d.token;
    const clientLastSeq = parseInt(d.lastSeq||0, 10);
    const lastReceiptSeq = parseInt(d.lastReceiptSeq||0, 10);
    const lastReactionSeq = parseInt(d.lastReactionSeq||0, 10);
    const lastDeletionSeq = parseInt(d.lastDeletionSeq||0, 10);
    // full=1 is only ever sent once, right after a reload, to rebuild the
    // chat log from scratch (the client never persists message content
    // locally — only the room session and a small expiry ledger). Normal
    // incremental polling never sets this and keeps excluding the caller's
    // own messages exactly as before, since the client already has those
    // from its own optimistic send.
    const includeOwn = d.full === 1 || d.full === '1';
    const room = rooms.get(roomCode);
    if (!room) return res200(res, { roomGone: true });
    if (!room.members.has(token)) return resErr(res,'Not in conversation.',403);

    const m = room.members.get(token);
    m.lastSeen = Date.now();

    // Peer info
    let peerName=null, peerOnline=false, peerPubKey=null;
    const now = Date.now();
    for (const [t,mb] of room.members) {
      if (t!==token) {
        peerName=mb.name; peerOnline=(now-mb.lastSeen)<8000; peerPubKey=mb.pubKey;
      }
    }

    // Messages since clientLastSeq, excluding own (unless this is the
    // one-time post-reload bootstrap fetch, which needs everything back —
    // the server is the only place a client's own sent messages still
    // exist once its in-memory chat log has been cleared by a reload).
    // System messages are the one exception to includeOwn: a "joined"
    // announcement caused by this same client has nothing to recover (it's
    // not content, there's no other copy of it anywhere worth restoring) —
    // letting includeOwn pull it back in on every reload just reintroduces
    // the exact self-echo ("X joined" shown to X) the from-tagging above
    // was added to prevent, since it bypassed that tag entirely.
    const newMsgs = room.msgs.filter(msg => {
      if (msg.seq <= clientLastSeq) return false;
      if (msg.deleted) return false; // deleted-for-everyone — nothing left to recover
      if (msg.type === 'system') return msg.from !== token;
      return includeOwn || msg.from !== token;
    });

    // Mark delivered — only for messages where the CALLER is the recipient,
    // not the original sender. Without the msg.from check, a full=1
    // bootstrap (which deliberately pulls back the caller's own sent
    // messages too, see includeOwn above — that's what lets a page refresh
    // rebuild history) would let a sender's own refresh mark their own
    // messages "delivered," even though nothing about that refresh
    // confirms the actual recipient's device ever saw anything. A normal
    // incremental poll never hit this, since newMsgs already excludes the
    // caller's own messages there — this only matters for the bootstrap
    // case, which is exactly the false-positive scenario being fixed.
    let deliveredChanged = false;
    for (const msg of newMsgs) {
      if (msg.type==='message' && msg.from !== token && !msg.deliveredAt) { msg.deliveredAt = Date.now(); deliveredChanged = true; }
    }
    if (deliveredChanged) publishInboxRoom(roomCode, 'receipt', { excludeToken:token });

    // Read receipts for sender's messages
    const readReceipts = [];
    for (const msg of room.msgs) {
      if (msg.from !== token || msg.type !== 'message' || !msg.deliveredAt) continue;
      // Return if: new delivery (seq > lastReceiptSeq) OR newly read (readAt set but not yet reported)
      if (msg.seq > lastReceiptSeq || (msg.readAt && !msg.readReported)) {
        readReceipts.push({ msgId: msg.id, seq: msg.seq, deliveredAt: msg.deliveredAt, readAt: msg.readAt || null });
        if (msg.readAt) msg.readReported = true;
      }
    }

    // Reaction updates — same seq-based sync pattern as read receipts, but its own
    // counter so a reaction on an old message doesn't get lost behind lastReceiptSeq
    const reactionUpdates = [];
    for (const msg of room.msgs) {
      if (msg.type !== 'message') continue;
      if (msg.reactionSeq && msg.reactionSeq > lastReactionSeq) {
        reactionUpdates.push({ msgId: msg.id, reactions: msg.reactions || {}, reactionSeq: msg.reactionSeq });
      }
    }

    // Deletions — same seq-based sync pattern as reactions/receipts. This is
    // what tells a peer whose session is already open (and who may have
    // already rendered this message, ahead of the seq-based filter above)
    // to remove it live; someone who hasn't reached its seq yet doesn't
    // need this at all, since the filter already keeps it out of `messages`.
    const deletions = [];
    for (const msg of room.msgs) {
      if (msg.deleted && msg.deletionSeq > lastDeletionSeq) {
        deletions.push({ msgId: msg.id, deletionSeq: msg.deletionSeq });
      }
    }

    return res200(res, { messages: newMsgs, peerName, peerOnline, peerPubKey, readReceipts, reactionUpdates, deletions, deleteTimer: room.deleteTimer, clearedAt: room.clearedAt || 0, totalMessageCount: room.totalMessageCount || 0, lastMessageAt: room.lastMessageAt || 0 });
  }

  // POST /api/mark-delivered — reports that a push notification actually
  // reached this device, independent of whether the page's own poll loop
  // ever gets a chance to run. A locked screen can throttle or suspend a
  // backgrounded tab's JS long before it would stop showing notifications,
  // so the sender could otherwise see a message stuck on a single tick even
  // though the recipient's device genuinely has it. Called from sw.js's
  // push handler — same deliveredAt field /api/poll already sets, just
  // triggered from a place that doesn't depend on the page being alive.
  if (path==='/api/mark-delivered' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId);
    if (msg && msg.type === 'message' && !msg.deliveredAt) {
      msg.deliveredAt = Date.now();
      publishInboxRoom(d.code, 'receipt', { excludeToken:d.token });
    }
    return res200(res, { ok: true });
  }

  // POST /api/read
  if (path==='/api/read' && method==='POST') {
    const room = rooms.get(d.code);
    if (room && room.members.has(d.token) && Array.isArray(d.msgIds)) {
      let changed = false;
      for (const msg of room.msgs) if (d.msgIds.includes(msg.id) && !msg.readAt) { msg.readAt = Date.now(); changed = true; }
      room.lastActivity = Date.now();
      if (changed) publishInboxRoom(d.code, 'receipt', { excludeToken:d.token });
    }
    return res200(res, { ok: true });
  }

  // POST /api/typing
  if (path==='/api/typing' && method==='POST') {
    const room = rooms.get(d.code);
    if (room && room.members.has(d.token)) {
      const m = room.members.get(d.token);
      m.lastSeen = Date.now(); m.typing = Date.now();
      room.lastActivity = Date.now();
      publishInboxRoom(d.code, 'typing', { excludeToken:d.token, payload:{ active:true } });
    }
    return res200(res, { ok: true });
  }

  // POST /api/check_typing — same reasoning as /api/poll above: this used
  // to be a GET with code/token as URL query parameters, fired every 2.5s
  // while a room is open, which meant the same standard infrastructure
  // access-log exposure applied here too. Moved to POST + JSON body.
  //
  // Also requires d.token to actually be a member now — it didn't check
  // membership at all before, so anyone who knew a room code (no token
  // needed) could read whether the other member was typing. Low severity
  // (read-only, leaks only a typing bit, not content) but worth closing for
  // consistency with every other room-scoped endpoint. Failing silently
  // with {typing:false} rather than a 403 is deliberate: this must not
  // become a room-existence oracle (a real room with no membership and a
  // nonexistent room both need to look identical from the outside).
  if (path==='/api/check_typing' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return res200(res,{typing:false});
    const now = Date.now();
    let typing = false;
    for (const [t,m] of room.members) if (t!==d.token && m.typing && now-m.typing<3000) typing=true;
    return res200(res,{typing});
  }

  // POST /api/leave — previously had NO auth check at all: it read d.code,
  // deleted whatever member matched d.token (a no-op if that token wasn't
  // actually a member), and pushed a system message using the caller's own
  // unverified d.name — anyone who merely knew a vault code could forge a
  // "${d.name} left" message into a room they were never part of, with no
  // length cap on d.name, no cap on room.msgs growth (the 100-message trim
  // only ever ran in /api/send), and no rate limit. Fixed with the same
  // auth pattern as /api/clear-chat: confirm room, confirm actual
  // membership, and derive the display name from the AUTHENTICATED member
  // (m.name) — never from d.name — before touching anything.
  //
  // The room/membership check itself has to be oracle-safe too: a 404 for
  // "room doesn't exist" and a 403 for "wrong token" would let anyone with
  // just a vault code (no valid token at all) tell live codes apart from
  // dead ones by probing this endpoint — exactly what /api/join's own
  // rate-limit hardening is trying to make expensive elsewhere. So every
  // outcome below — missing room, bad token, or an actual successful leave
  // — returns the identical 204 with no body.
  if (path==='/api/leave' && method==='POST') {
    if (rateLimited(`leave:${ip}`, 20, 10 * 60 * 1000)) {
      return resErr(res, 'Too many leave attempts from this connection — try again in a few minutes.', 429);
    }
    const room = rooms.get(d.code);
    const m = (room && typeof d.token === 'string') ? room.members.get(d.token) : null;
    if (!room || !m) return res204(res);
    room.members.delete(d.token);
    room.lastActivity = Date.now();
    pushRoomMsg(room, { seq:++room.seq, id:uid(), type:'system', content:`${m.name} left`, ts:Date.now() });
    publishInboxRoom(d.code, 'membership', { excludeToken:d.token });
    if (room.members.size===0) destroyRoom(d.code);
    return res204(res);
  }

  // POST /api/close
  if (path==='/api/close' && method==='POST') {
    // Previously deleted the room by code alone with no check that the
    // caller was actually a member — meaning anyone who merely knew (or
    // guessed) a room's code could erase it out from under the two people
    // actually using it, with no credential required at all. Every other
    // room-scoped endpoint here already gates on room.members.has(d.token);
    // this just brings Close & erase in line with that same pattern. Stays
    // silently idempotent (always {ok:true}) either way, so this doesn't
    // leak whether a given code currently exists to an unauthenticated caller.
    const room = rooms.get(d.code);
    if (room && room.members.has(d.token)) destroyRoom(d.code);
    return res200(res,{ok:true});
  }

  // POST /api/make-persistent — converts an ORDINARY room into a permanent
  // link in place: same code, same history, same encryption keys, nothing
  // resets. This is the "you've reopened this a few times, want it to stop
  // expiring?" conversion path, distinct from /api/revoke-link below, which
  // deliberately destroys and replaces a room. Nothing is destroyed here —
  // it's purely an exemption from the TTL sweep from this point forward.
  if (path==='/api/make-persistent' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    if (!room.persistent) {
      room.persistent = true;
      // The true historical moment the second person first joined was
      // never tracked for an ordinary room — backfill with "now" if both
      // are already members (which they almost certainly are, by the time
      // someone's reopened this room enough to see the suggestion). Not
      // exact, but honest about the relationship being real at the point
      // of conversion rather than claiming a start date that isn't real.
      if (!room.connectedSince && room.members.size >= 2) room.connectedSince = Date.now();
      if (room.totalMessageCount === undefined) room.totalMessageCount = 0;
      console.log(`Room converted to permanent room: ${logCode(d.code)}`);
    }
    return res200(res, { ok: true, persistent: true, connectedSince: room.connectedSince || null, totalMessageCount: room.totalMessageCount || 0 });
  }

  // POST /api/revoke-link — kills a permanent Anon Link (and everything in
  // it) so a new one can be minted. Same destructive effect as /api/close,
  // but named/scoped separately since it's reached from a different part
  // of the UI (room settings, not the header's Close & erase) and only
  // makes sense for persistent rooms — trying it on an ordinary room is
  // almost certainly a client bug, not a real revoke request, so it's
  // rejected rather than silently doing a full close.
  if (path==='/api/revoke-link' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Conversation not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in conversation.',403);
    if (!room.persistent) return resErr(res,'This conversation is not persistent.',400);
    destroyRoom(d.code);
    console.log(`Anon Link revoked: ${logCode(d.code)}`);
    return res200(res,{ok:true});
  }

  // GET /api/admin/stats — aggregate room-creation counts only, gated by a
  // shared-secret key set via the ADMIN_KEY env var. Returns a 404 rather
  // than 401/403 on a missing/wrong key so the endpoint's existence isn't
  // revealed to anyone who doesn't already have the key.
  //
  // Key travels via an Authorization: Bearer header now, not ?key=... in the
  // query string — a query string lands in Railway's access logs, browser
  // history, and any referrer header, the exact same exposure already fixed
  // for /api/poll, /api/check_typing, and the WS signaling auth. Compared
  // with crypto.timingSafeEqual rather than !== so a wrong guess can't be
  // narrowed down via response-time differences; timingSafeEqual throws on
  // mismatched buffer lengths, so that has to be checked first.
  if (path === '/api/admin/stats' && method === 'GET') {
    const authHeader = (headers && headers['authorization']) || '';
    const bearerMatch = /^Bearer (.+)$/.exec(authHeader);
    const providedKey = bearerMatch ? bearerMatch[1] : null;
    const expectedKey = ADMIN_KEY;
    if (!expectedKey || !providedKey) {
      res.writeHead(404); res.end(); return;
    }
    if (isRateLimited(`admin-auth:${ip}`, 10, ADMIN_AUTH_WINDOW_MS)) {
      res.writeHead(404); res.end(); return;
    }
    const providedBuf = Buffer.from(providedKey);
    const expectedBuf = Buffer.from(expectedKey);
    if (providedBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(providedBuf, expectedBuf)) {
      // Count failed guesses only. The dashboard refreshes every 15 seconds;
      // counting successful requests here locked a legitimate administrator
      // out after ten refreshes even though every supplied key was correct.
      rateLimited(`admin-auth:${ip}`, 10, ADMIN_AUTH_WINDOW_MS);
      res.writeHead(404); res.end(); return;
    }
    const total = analytics.roomsCreatedTemporary + analytics.roomsCreatedPermanent;
    const now = Date.now();
    const activeCutoff = now - 60 * 1000;
    let activeAnonymousSessions = 0;
    let occupiedVaults = 0;
    let permanentVaults = 0;
    let temporaryVaults = 0;
    let activeCalls = 0;
    let ringingCalls = 0;
    let storedCiphertextMessages = 0;
    for (const room of rooms.values()) {
      if (room.persistent) permanentVaults++; else temporaryVaults++;
      if (room.members.size > 0) occupiedVaults++;
      for (const member of room.members.values()) {
        if ((member.lastSeen || 0) >= activeCutoff) activeAnonymousSessions++;
      }
      if (room.ringingUntil && room.ringingUntil > now) ringingCalls++;
      if (room.activeCall) activeCalls++;
      storedCiphertextMessages += room.msgs.length;
    }
    const memory = process.memoryUsage();
    const days = Object.entries(analytics.daily || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-90)
      .map(([date, values]) => ({ date, ...values }));
    res.setHeader('Cache-Control', 'no-store');
    return res200(res, {
      generatedAt: now,
      privacy: {
        mode: 'aggregate-only',
        storesVaultCodes: false,
        storesCodenames: false,
        storesIpAddresses: false,
        canReadMessages: false,
      },
      live: {
        activeVaults: rooms.size,
        occupiedVaults,
        permanentVaults,
        temporaryVaults,
        activeAnonymousSessions,
        authenticatedSignalSockets: signalingSockets.size + nativeCallSignalingSockets.size,
        activeCalls,
        ringingCalls,
        storedCiphertextMessages,
      },
      lifetime: {
        roomsCreatedTemporary: analytics.roomsCreatedTemporary,
        roomsCreatedPermanent: analytics.roomsCreatedPermanent,
        totalRoomsCreated: total,
        permanentPct: total ? Math.round((analytics.roomsCreatedPermanent / total) * 100) : 0,
        joins: analytics.joins || 0,
        messagesRelayed: analytics.messagesRelayed || 0,
        callsStarted: analytics.callsStarted || 0,
        callsAnswered: analytics.callsAnswered || 0,
      },
      system: {
        uptimeSeconds: Math.floor((now - PROCESS_STARTED_AT) / 1000),
        nodeVersion: process.version,
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        ciphertextBytes: totalByteSize,
        ciphertextBudgetBytes: GLOBAL_BYTE_BUDGET,
        roomCapacity: MAX_CONCURRENT_ROOMS,
      },
      daily: days,
    });
  }

  resErr(res,'Not found.',404);
}

// ── CALL SIGNALING (WebSocket) ───────────────────────────────────────────
// Carries offer/answer/ICE candidates for calling — added alongside the
// existing HTTP polling above, not replacing it. Messages, reactions,
// receipts and deletes all still go through /api/poll exactly as before;
// this channel exists only because call setup needs to be near-instant in
// a way a 2-second poll loop can't deliver.
//
// The server here is a dumb, blind relay, on purpose: every message this
// forwards has its real content (SDP, ICE candidates) already encrypted
// client-side with the room's existing E2E key before it ever reaches this
// process — see encryptSignalPayload/decryptSignalEnvelope in the client.
// What this process sees is `{ type, envelope }`, where `envelope` is
// opaque ciphertext it cannot read or usefully tamper with. That matters
// specifically for calling: a WebRTC call's DTLS fingerprint travels inside
// the SDP, and whoever controls the signaling channel unencrypted could
// otherwise substitute their own fingerprint and sit in the middle of a
// call that still looks end-to-end encrypted at the media layer. Keeping
// this server blind to the payload is what closes that gap.
// ws defaults to 100MB per frame with no explicit maxPayload — this relay
// only ever needs to carry small signaling messages (call state, SDP,
// ICE candidates), so that default was pure unused headroom an attacker
// could exploit. Measured (not guessed) the real ceiling: an actual
// audio+video SDP offer, generated by this browser engine's real WebRTC
// stack (VP8/VP9/AV1/H264 codec lists, RTX, RED, etc.) and run through
// this app's real encryptSignalPayload+encryptMsg chain, came out to
// ~8.5KB on the wire — the largest legitimate signaling message this app
// sends (audio-only offers and answers measured smaller, ~2-8KB). 64KB
// gives ~7.5x headroom above that measured max for codec/extension
// variation across devices, while still being a hard, meaningful cap
// (down from ws's 100MB default).
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const inboxWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

// One live socket per participant, keyed by their room token — not by room
// code, since a signaling message needs to reach one specific person, not
// broadcast to a room. Same token space /api/poll already authenticates
// against; nothing new to trust here.
const signalingSockets = new Map();
// Native iOS incoming calls have a separate signaling owner. Keeping this
// socket alongside (rather than replacing) WKWebView's socket prevents a
// foreground/reconnect race from sending an offer or hang-up to the wrong
// WebRTC engine. When present, it has priority for signals addressed to
// that participant; the web socket remains available for outgoing web calls.
const nativeCallSignalingSockets = new Map();
const inboxAccountSockets = new Map();
// Direct fan-out index: room code -> sockets currently subscribed to it.
// Without this, every message/receipt/typing event scanned every online
// account socket just to find the two participants, making event delivery
// O(all online devices). Keep account ownership separately for auth and
// cleanup, while this index makes ordinary room delivery O(participants).
const inboxSocketsByRoom = new Map();
const inboxSequenceByAccount = new Map();

function nextInboxSequence(accountId) {
  const next = (inboxSequenceByAccount.get(accountId) || 0) + 1;
  inboxSequenceByAccount.set(accountId, next);
  return next;
}

// Live inbox subscriptions deliberately stay process-only. The durable account
// file therefore still cannot reveal which vaults belong to an identity. When
// a device reconnects it proves each room membership again with its existing
// bearer token and catches up from the room's durable sequence counters.
function publishInboxRoom(roomCode, change, { excludeToken = null, payload = null } = {}) {
  const sockets = inboxSocketsByRoom.get(roomCode);
  if (!sockets) return;
  for (const ws of sockets) {
    const subscribedToken = ws.inboxSubscriptions?.get(roomCode);
    if (!subscribedToken || subscribedToken === excludeToken || ws.readyState !== ws.OPEN || !ws.accountId) continue;
    try {
      ws.send(JSON.stringify({
        type: change === 'typing' ? 'typing' : 'room-update',
        roomCode,
        change,
        sequence: nextInboxSequence(ws.accountId),
        ...(payload || {}),
      }));
    } catch (e) {}
  }
}

function publishInboxAccount(accountId, change, payload = null) {
  const sockets = inboxAccountSockets.get(accountId);
  if (!sockets) return;
  for (const ws of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    try {
      ws.send(JSON.stringify({ type:'account-update', change, sequence:nextInboxSequence(accountId), ...(payload || {}) }));
    } catch (e) {}
  }
}

function hasLiveInboxSubscription(roomCode, token, exceptSocket = null) {
  const sockets = inboxSocketsByRoom.get(roomCode);
  if (!sockets) return false;
  for (const socket of sockets) {
    if (socket !== exceptSocket && socket.readyState === socket.OPEN && socket.inboxSubscriptions?.get(roomCode) === token) return true;
  }
  return false;
}

function replaceInboxSubscriptions(ws, subscriptions) {
  for (const code of ws.inboxSubscriptions.keys()) {
    if (subscriptions.has(code)) continue;
    const sockets = inboxSocketsByRoom.get(code);
    if (!sockets) continue;
    sockets.delete(ws);
    if (sockets.size === 0) inboxSocketsByRoom.delete(code);
  }
  for (const code of subscriptions.keys()) {
    let sockets = inboxSocketsByRoom.get(code);
    if (!sockets) { sockets = new Set(); inboxSocketsByRoom.set(code, sockets); }
    sockets.add(ws);
  }
  ws.inboxSubscriptions = subscriptions;
}

// Every type handleSignalMessage() actually branches on in client/index.html
// (checked against that source directly, not from memory) — anything else
// is silently dropped rather than relayed.
const SIGNAL_TYPE_ALLOWLIST = new Set([
  'call-invite', 'call-ringing', 'call-accept', 'call-decline', 'call-busy',
  'call-hangup', 'offer', 'answer', 'ice-candidate', 'call-reaction',
]);

srv.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
  if (u.pathname === '/ws/inbox') {
    inboxWss.handleUpgrade(req, socket, head, (ws) => inboxWss.emit('connection', ws, req));
    return;
  }
  if (u.pathname !== '/ws/signal') { socket.destroy(); return; }

  // Auth used to happen right here, reading code/token off the query
  // string — the socket opens "blind" now instead, and must authenticate
  // as its very first message once connected (see wss.on('connection')
  // below). A native browser WebSocket can't send a custom body or headers
  // during the handshake itself, so the URL used to be the only place to
  // put these — which meant the room code and auth token sat in the
  // connection URL, visible in Railway's access logs and any browser dev
  // tools network tab, the same exposure /api/poll and /api/check_typing
  // already had fixed by moving to POST bodies. This closes the same gap
  // for the one remaining place it existed.
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

inboxWss.on('connection', (ws) => {
  ws.authenticated = false;
  ws.isAlive = true;
  ws.inboxSubscriptions = new Map();
  ws.on('pong', () => {
    ws.isAlive = true;
    const now = Date.now();
    for (const [code, token] of ws.inboxSubscriptions) {
      const member = rooms.get(code)?.members.get(token);
      if (member) member.lastSeen = now;
    }
  });
  ws.on('error', (err) => console.error('Inbox socket error:', err.message));
  const authTimer = setTimeout(() => {
    if (!ws.authenticated) { try { ws.close(4003, 'Auth timeout'); } catch (e) {} }
  }, 5000);
  authTimer.unref();

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { msg = null; }
    if (!ws.authenticated) {
      if (!msg || msg.type !== 'auth' || !validAccountId(msg.accountId) ||
          !authenticateAccountSession(msg.accountId, msg.sessionToken)) {
        clearTimeout(authTimer);
        try { ws.close(4001, 'Unauthorized'); } catch (e) {}
        return;
      }
      clearTimeout(authTimer);
      ws.authenticated = true;
      ws.accountId = msg.accountId;
      let sockets = inboxAccountSockets.get(msg.accountId);
      if (!sockets) { sockets = new Set(); inboxAccountSockets.set(msg.accountId, sockets); }
      sockets.add(ws);
      try { ws.send(JSON.stringify({ type:'ready', sequence:inboxSequenceByAccount.get(msg.accountId) || 0 })); } catch (e) {}
      return;
    }
    if (!msg || msg.type !== 'subscribe' || !Array.isArray(msg.conversations)) return;
    const subscriptions = new Map();
    for (const item of msg.conversations.slice(0, 20)) {
      if (!item || typeof item.code !== 'string' || typeof item.token !== 'string') continue;
      const code = item.code.toLowerCase().trim();
      const room = rooms.get(code);
      if (room?.members.has(item.token)) subscriptions.set(code, item.token);
    }
    replaceInboxSubscriptions(ws, subscriptions);
    for (const [code, token] of subscriptions) {
      const member = rooms.get(code)?.members.get(token);
      if (member) member.lastSeen = Date.now();
      publishInboxRoom(code, 'presence', { excludeToken:token });
    }
    try { ws.send(JSON.stringify({ type:'subscribed', count:subscriptions.size })); } catch (e) {}
  });

  ws.on('close', () => {
    if (!ws.accountId) return;
    const sockets = inboxAccountSockets.get(ws.accountId);
    if (!sockets) return;
    sockets.delete(ws);
    if (sockets.size === 0) inboxAccountSockets.delete(ws.accountId);
    const closingSubscriptions = new Map(ws.inboxSubscriptions);
    replaceInboxSubscriptions(ws, new Map());
    for (const [code, token] of closingSubscriptions) {
      if (hasLiveInboxSubscription(code, token, ws)) continue;
      const member = rooms.get(code)?.members.get(token);
      if (member) member.lastSeen = 0;
      publishInboxRoom(code, 'presence', { excludeToken:token });
    }
  });
});

wss.on('connection', (ws) => {
  ws.authenticated = false;

  // Without this, a frame that exceeds maxPayload makes ws emit an 'error'
  // event on the socket — and an 'error' event with no listener is one of
  // the few EventEmitter events Node treats specially: unhandled, it throws
  // and crashes the ENTIRE process, not just this connection. Confirmed by
  // actually triggering it (an oversized frame reproducibly killed the
  // whole server before this handler existed) rather than assuming
  // maxPayload alone was a safe, self-contained fix. This just lets ws's
  // own protocol-level close (code 1009) proceed normally — the close
  // handler below still fires and cleans up signalingSockets same as any
  // other disconnect.
  ws.on('error', (err) => {
    console.error(`Signal socket error (room ${ws.roomCode ? logCode(ws.roomCode) : 'pre-auth'}):`, err.message);
  });

  // Clean up on close regardless of whether auth ever completed — if it
  // didn't, ws.token was never set, so the signalingSockets lookup below is
  // just a harmless no-op.
  ws.on('close', () => {
    if (ws.token && signalingSockets.get(ws.token) === ws) signalingSockets.delete(ws.token);
    if (ws.token && nativeCallSignalingSockets.get(ws.token) === ws) nativeCallSignalingSockets.delete(ws.token);
  });

  // An unauthenticated socket that never sends anything gets 5 seconds to
  // do so before it's dropped — otherwise a connection that opens and just
  // sits there (deliberately or not) would hold a live socket open forever.
  const authTimer = setTimeout(() => {
    if (!ws.authenticated) { try { ws.close(4003, 'Auth timeout'); } catch(e) {} }
  }, 5000);

  ws.once('message', (raw) => {
    clearTimeout(authTimer);
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { msg = null; }
    if (!msg || msg.type !== 'auth' || typeof msg.code !== 'string' || typeof msg.token !== 'string') {
      try { ws.close(4001, 'Auth required'); } catch(e) {}
      return;
    }
    const roomCode = msg.code.toLowerCase().trim();
    const token = msg.token;
    const room = rooms.get(roomCode);
    if (!room || !room.members.has(token)) {
      try { ws.close(4001, 'Unauthorized'); } catch(e) {}
      return;
    }

    ws.authenticated = true;
    ws.roomCode = roomCode;
    ws.token = token;
    ws.nativeCallOwner = msg.nativeCall === true;

    // A reconnect (network switch, tab backgrounded and resumed, etc.)
    // replaces the old socket for this token rather than stacking up dead
    // connections that'd otherwise both "successfully" receive a relay.
    const socketRegistry = ws.nativeCallOwner ? nativeCallSignalingSockets : signalingSockets;
    const existing = socketRegistry.get(token);
    if (existing && existing !== ws) { try { existing.close(4002, 'Replaced by new connection'); } catch(e) {} }
    socketRegistry.set(token, ws);
    // Explicit authentication acknowledgement for native call clients.
    // URLSessionWebSocketTask may accept sends while its connection/auth
    // handshake is still in flight; without an acknowledgement the native
    // engine could send call-accept or ICE into that race and then wait
    // forever. Browser clients safely ignore this envelope-free control
    // frame, while the iOS engine uses it to flush its bounded signal queue.
    try { ws.send(JSON.stringify({ type: 'ready' })); } catch (e) {}
    // Pseudonymized room code only — no token material at all (even a
    // truncated bearer token is credential material and has no business in
    // a log line), enough to confirm connectivity during testing without
    // logging anything that identifies a person, a device, or any
    // message/signal content.
    console.log(`Signal socket connected: room ${logCode(roomCode)}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Real signaling traffic only starts arriving now that this socket is
    // authenticated — everything below is unchanged from before, it's just
    // registered here (post-auth) instead of unconditionally at connection
    // time.
    ws.on('message', (raw2) => {
      let msg2;
      try { msg2 = JSON.parse(raw2); } catch (e) { return; }
      if (!msg2 || typeof msg2.type !== 'string' || typeof msg2.envelope !== 'string') return;
      // Only relay signaling types the client actually understands — derived
      // from handleSignalMessage's branches in client/index.html (verified
      // against the source, not from memory), not a made-up guess. A type
      // outside this set is silently dropped (return, not close) rather than
      // disconnecting the socket — a future/older client version sending a
      // type this deploy doesn't recognize yet shouldn't get kicked off.
      if (!SIGNAL_TYPE_ALLOWLIST.has(msg2.type)) return;
      // sessionId travels unencrypted (see the comment below) and went
      // straight into the relayed JSON with no type or length check at all —
      // it could be an object, an array, or an arbitrarily large string. The
      // client only ever generates a short nonce here (~18 chars: 'sg' +
      // Date.now().toString(36) + an 8-char random suffix); 128 is generous
      // headroom, not a guess at what's actually needed.
      if (msg2.sessionId !== undefined && (typeof msg2.sessionId !== 'string' || msg2.sessionId.length > 128)) return;
      // Opaque per-call nonce used only for retry deduplication. It contains
      // no room code, token, caller identity, or encrypted call content.
      // Older clients omit it and retain the legacy ringing-window behavior
      // during a rolling deployment.
      if (msg2.inviteId !== undefined &&
          (typeof msg2.inviteId !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(msg2.inviteId))) return;
      // envelope is already bounded by maxPayload above (the whole frame
      // can't exceed 64KB), but checking it explicitly here too is
      // deliberate belt-and-braces: it fails on this specific field with a
      // clear reason, rather than relying solely on ws's frame-level cutoff
      // to catch it incidentally.
      if (msg2.envelope.length > 64 * 1024) return;
      // Bursty by design: ICE candidate exchange fires many messages within
      // a second or two of call setup (and again on camera-toggle
      // renegotiation), on top of the call-state messages already flowing.
      // 60/10s comfortably covers that — the client's own call-invite retry
      // loop alone is only 1 every 3s, sustained, not bursty.
      if (rateLimited(`sig:${token}`, 60, 10 * 1000)) return;

      const room2 = rooms.get(roomCode);
      if (!room2 || !room2.members.has(token)) { try { ws.close(4001, 'No longer in room'); } catch(e) {} return; }
      room2.lastActivity = Date.now();

      // A terminal native action can race the caller's already-scheduled
      // three-second invitation retry. Drop that exact invitation before it
      // is relayed or allowed to create another native notification. A new
      // call carries a fresh random inviteId and remains unaffected.
      if (msg2.type === 'call-invite' && isInviteTerminated(room2, msg2.inviteId)) return;

      // 1:1 rooms only ever have one other member — relay to them if they
      // currently have a live socket. If they don't (call app not open on
      // their end right now), the message is simply dropped; there's no
      // queue, no retry, no persistence — same "never stored" posture as
      // everything else in this app.
      for (const [tok, peerMember] of room2.members) {
        if (tok === token) continue;
        const nativePeerWs = nativeCallSignalingSockets.get(tok);
        const peerWs = nativePeerWs && nativePeerWs.readyState === nativePeerWs.OPEN
          ? nativePeerWs
          : signalingSockets.get(tok);
        if (peerWs && peerWs.readyState === peerWs.OPEN) {
          // sessionId is a random per-page-load nonce the client uses to tell
          // "the peer's session actually restarted" apart from "this looks
          // like a replay" in its own sequence-number check — meaningless to
          // this server, just forwarded along with everything else opaque.
          peerWs.send(JSON.stringify({ type: msg2.type, from: token, sessionId: msg2.sessionId, inviteId: msg2.inviteId, envelope: msg2.envelope }));
          // No success log here on purpose — this fires on every single
          // signaling message (every ICE candidate included), which was
          // flooding Railway's logs. The dropped-peer case below is the one
          // actually worth seeing.
        } else {
          console.log(`Signal dropped (peer not connected): room ${logCode(roomCode)} type ${msg2.type}`);
        }

        // A dropped call-invite means the receiver's phone was locked or the
        // app was backgrounded/killed — their signaling socket wasn't open to
        // catch it. Same problem messages already solved with Web Push: wake
        // the device so its client reconnects the socket, then the client's
        // own re-announce loop (every 3s while ringing) delivers a live
        // invite once that reconnect lands. Only fires once per ring (not on
        // every 3s retry) so a locked phone doesn't buzz repeatedly. The
        // caller's chosen name is already plaintext on this server (room
        // membership records — same field the ordinary message push above
        // already puts in "New message from X"), so it's safe to name them
        // here too instead of a generic "Incoming call".
        if (msg2.type === 'call-invite') {
          const now = Date.now();
          const inviteId = msg2.inviteId || null;
          const nativeCallInProgress = Boolean(room2.nativeCallId && room2.nativeCalleeToken);
          const isNewInvitation = inviteId
            ? room2.nativeInviteId !== inviteId
            // Older native builds did not attach inviteId. Once the server
            // has a native call owner or has observed acceptance, a late
            // retry is still the same call even though ringingUntil is now
            // zero. Treating it as new created a second CallKit call roughly
            // 10 seconds after the first was answered.
            : !(nativeCallInProgress || room2.activeCall || (room2.ringingUntil && room2.ringingUntil > now));
          // A new invitation supersedes any stale native ring retained for
          // this room. Close that old surface before issuing the new call ID
          // so OEM lock screens cannot leave both activities around.
          if (isNewInvitation && room2.nativeCallId && room2.nativeCalleeToken) {
            const previousCallee = room2.members.get(room2.nativeCalleeToken);
            if (previousCallee) sendNativeCallEnd(previousCallee, room2.nativeCallId).catch(() => {});
            room2.nativeCallId = null;
            room2.nativeCalleeToken = null;
          }
          // The caller re-announces while waiting for acknowledgement. Once
          // CallKit exists, its native call ID remains authoritative until
          // decline/hang-up; otherwise clearing ringingUntil on acceptance
          // lets a late retry create a second lock-screen call.
          const alreadyRinging = inviteId
            ? (!isNewInvitation && (nativeCallInProgress || Boolean(room2.ringingUntil && room2.ringingUntil > now)))
            : (nativeCallInProgress || Boolean(room2.ringingUntil && room2.ringingUntil > now));
          if (!alreadyRinging) {
            analytics.callsStarted = (analytics.callsStarted || 0) + 1;
            trackAggregate('callsStarted');
          }
          // A connected call is not ringing. Reopening this window would also
          // make a normal hang-up look like a missed call.
          if (!nativeCallInProgress) {
            room2.ringingUntil = now + 30000; // matches client CALL_RING_TIMEOUT_MS
          }
          if (inviteId) room2.nativeInviteId = inviteId;
          if (!alreadyRinging && (peerMember.voipToken || hasPushDestination(peerMember))) {
            const caller = room2.members.get(token);
            const nativeCallId = crypto.randomUUID();
            room2.nativeCallId = nativeCallId;
            // Retain the callee member token for both native platforms. It is
            // server-side room state only and lets a native Android decline
            // identify the caller without exposing room credentials.
            room2.nativeCalleeToken = tok;
            // code rides along so tapping the notification (see sw.js's
            // notificationclick) can jump straight to the room the call is
            // actually in, rather than whichever room the app happens to open
            // to — matters most with multiple rooms open, where "the call" and
            // "the room on screen when you unlock" are often different rooms.
            const payload = JSON.stringify({
              title: 'Vaultlix',
              body: caller && caller.name ? `${caller.name} is calling` : 'Incoming call',
              tag: `vaultlix-call-${roomCode}`,
              isCall: true,
              caller: caller && caller.name ? String(caller.name).slice(0, 80) : 'Vaultlix caller',
              callId: nativeCallId,
              code: roomCode,
            });
            if (peerMember.voipToken) {
              // APNs receives no vault code, member name, or room credential.
              // The app resolves the room only after its authenticated signal
              // sockets reconnect and receive the encrypted call invitation.
              sendVoipPush(peerMember, {
                aps: { 'content-available': 1 },
                action: 'incoming',
                callId: nativeCallId,
                caller: caller && caller.name ? String(caller.name).slice(0, 80) : 'Vaultlix caller',
                hasVideo: false,
                // Opaque random handle generated and stored only on the
                // recipient device. APNs does not receive the vault code,
                // membership token, or E2E key.
                roomHandle: peerMember.nativeRoomHandle,
              }).then(ok => {
                if (!ok) sendMemberPush(peerMember, payload, { urgency: 'high', TTL: 30, label: 'call fallback' });
              });
            } else {
              sendMemberPush(peerMember, payload, { urgency: 'high', TTL: 30, label: 'call' });
            }

            // iOS web push has no equivalent of the high-priority "VoIP push"
            // tier native apps get (that's reserved for PushKit, not available
            // to web apps at all) — reported single-attempt delivery on iOS
            // runs roughly 70-85% vs 90-95% on Android. A push that silently
            // never lands means the callee's phone just sits there through the
            // whole ring with nothing to tap. One retry partway through the
            // 30s window, only if the call is still genuinely ringing (nobody
            // answered/declined/hung up, and no newer call superseded this
            // one), gives it a second independent shot without turning into
            // the every-3s buzzing the alreadyRinging guard above exists to
            // prevent.
            const ringMarker = room2.ringingUntil;
            const inviteMarker = room2.nativeInviteId;
            setTimeout(() => {
              if (room2.ringingUntil !== ringMarker || room2.ringingUntil <= Date.now()) return;
              if (room2.nativeInviteId !== inviteMarker) return;
              if (peerMember.voipToken) return;
              if (!hasPushDestination(peerMember)) return; // already known-dead from the first attempt
              sendMemberPush(peerMember, payload, { urgency: 'high', TTL: 15, label: 'call retry' });
            }, 5000);
          }
        } else if (msg2.type === 'call-accept') {
          if (room2.ringingUntil && room2.ringingUntil > Date.now()) {
            analytics.callsAnswered = (analytics.callsAnswered || 0) + 1;
            trackAggregate('callsAnswered');
          }
          room2.ringingUntil = 0;
          room2.activeCall = true;
        } else if (msg2.type === 'call-decline' || msg2.type === 'call-busy') {
          markInviteTerminated(room2, msg2.inviteId || room2.nativeInviteId);
          room2.ringingUntil = 0;
          room2.activeCall = false;
          room2.nativeCallId = null;
          room2.nativeCalleeToken = null;
        } else if (msg2.type === 'call-hangup') {
          // A hangup landing while the ring window is still open means
          // nobody ever answered — the caller gave up (their own 30s ring
          // timeout, or a manual cancel) before the callee picked up. That's
          // a missed call from the callee's side, and worth a second, distinct
          // push beyond the original "Incoming call" one: their device may
          // have been locked/backgrounded through the whole ring and never
          // surfaced anything past that first notification — same as a phone
          // showing a missed-call notification separate from the ringing one.
          const now = Date.now();
          markInviteTerminated(room2, msg2.inviteId || room2.nativeInviteId, now);
          const wasStillRinging = room2.ringingUntil && room2.ringingUntil > now;
          room2.ringingUntil = 0;
          room2.activeCall = false;
          const nativeCallId = room2.nativeCallId;
          const nativeCallee = room2.nativeCalleeToken ? room2.members.get(room2.nativeCalleeToken) : null;
          room2.nativeCallId = null;
          room2.nativeCalleeToken = null;
          if (nativeCallId && nativeCallee) sendNativeCallEnd(nativeCallee, nativeCallId).catch(() => {});
          // Android's full-screen incoming-call surface is native too. Its
          // WebSocket may be frozen while the keyguard is up, so send a
          // data-only FCM terminal event keyed to this call. This closes the
          // native UI without displaying a second notification.
          if (peerMember.fcmToken) {
            sendFcmNotification(peerMember, JSON.stringify({
              isCallEnd: true,
              missedCall: !!wasStillRinging,
              callId: nativeCallId || '',
              code: roomCode,
            }), 30).catch(() => {});
          }
          if (wasStillRinging && hasPushDestination(peerMember)) {
            const caller = room2.members.get(token);
            const missedPayload = JSON.stringify({
              title: 'Vaultlix',
              body: caller && caller.name ? `Missed call from ${caller.name}` : 'Missed call',
              tag: `vaultlix-missed-${roomCode}-${now}`,
              isCall: false,
              missedCall: true,
              caller: caller && caller.name ? String(caller.name).slice(0, 80) : 'Vaultlix caller',
              callId: nativeCallId || '',
              code: roomCode,
            });
            sendMemberPush(peerMember, missedPayload, { urgency: 'high', TTL: 3600, label: 'missed call' });
          }
        }
        break;
      }
    });
  });
});

// Railway's proxy (and mobile carriers) will silently drop an idle
// WebSocket connection without either side finding out. Ping every 25s and
// terminate anything that didn't pong back since the last sweep — the
// client's reconnect-with-backoff logic picks it back up from there.
setInterval(() => {
  for (const server of [wss, inboxWss]) server.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

// ── DURABLE ROOM CHECKPOINT ──────────────────────────────────────────────────
// Rooms remain live in memory, but an atomic checkpoint is also refreshed on
// persistent storage. This makes a Railway volume backup useful: a backup
// taken while the process is running contains a recent room map rather than
// only account files. Shutdown still writes one final checkpoint, while the
// periodic writer covers hard crashes and backups taken during normal use.
//
// SNAPSHOT_DIR must point at storage that survives the *container* being
// torn down and recreated, not just the process inside it — i.e. a Railway
// Volume, not the container's own ephemeral disk. Without a Volume attached
// and SNAPSHOT_DIR pointed at its mount path, this still runs safely (falls
// back to a local folder next to the server code) but a real deploy will
// still lose rooms, same as before. See the boot-time log line below.
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(__dirname, '.data');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'rooms-snapshot.json');
const SNAPSHOT_TMP_PATH = SNAPSHOT_PATH + '.tmp';
const ROOM_CHECKPOINT_INTERVAL_MS = Math.max(1000, parseInt(process.env.ROOM_CHECKPOINT_INTERVAL_MS || '15000', 10));
const ACCOUNTS_PATH = path.join(SNAPSHOT_DIR, 'accounts.json');
const ACCOUNTS_TMP_PATH = ACCOUNTS_PATH + '.tmp';
const REPORTS_PATH = path.join(SNAPSHOT_DIR, 'safety-reports.jsonl');
const REPORTS_TMP_PATH = REPORTS_PATH + '.tmp';
const SAFETY_REPORT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

function appendSafetyReport(report) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
  let retained = [];
  if (fs.existsSync(REPORTS_PATH)) {
    const cutoff = Date.now() - SAFETY_REPORT_RETENTION_MS;
    retained = fs.readFileSync(REPORTS_PATH, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { const parsed = JSON.parse(line); return Date.parse(parsed.createdAt) >= cutoff ? [parsed] : []; }
      catch (e) { return []; }
    });
  }
  retained.push(report);
  retained = retained.slice(-10000);
  fs.writeFileSync(REPORTS_TMP_PATH, retained.map(item => JSON.stringify(item)).join('\n') + '\n', { encoding:'utf8', mode:0o600 });
  fs.renameSync(REPORTS_TMP_PATH, REPORTS_PATH);
  fs.chmodSync(REPORTS_PATH, 0o600);
}

// Anonymous account ciphertext must survive every restart independently of
// the live-room checkpoint. Atomic replacement prevents a power loss or
// container kill during a write from truncating the only copy.
function saveAccounts() {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    const data = JSON.stringify(Array.from(accounts.entries()));
    const fd = fs.openSync(ACCOUNTS_TMP_PATH, 'w', 0o600);
    try { fs.writeSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.chmodSync(ACCOUNTS_TMP_PATH, 0o600);
    fs.renameSync(ACCOUNTS_TMP_PATH, ACCOUNTS_PATH);
    fs.chmodSync(ACCOUNTS_PATH, 0o600);
  } catch (e) { console.error('Anonymous account save failed:', e.message); }
}

function hydrateAccounts(entries, source) {
  if (!Array.isArray(entries)) throw new Error(`invalid ${source} account records`);
  accounts.clear();
  privateNumbers.clear();
  for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || !validAccountId(entry[0])) continue;
      const record = entry[1];
      if (!record || record.version !== 2 || !normalizePrivateNumber(record.privateNumber) || !normalizeDisplayName(record.displayName) || !record.authVerifier || !record.recoveryVerifier ||
          !validEncryptedField(record.passwordWrap, 4096) || !validEncryptedField(record.recoveryWrap, 4096) ||
          !validEncryptedField(record.bundle, 1024 * 1024)) continue;
      record.sessions = (record.sessions || []).filter(s => s && s.expiresAt > Date.now() && /^[a-f0-9]{64}$/.test(s.tokenHash || '')).slice(-5);
      record.pushDestinations = (record.pushDestinations || []).flatMap(destination => {
        if (destination?.platform === 'android') {
          const fcmToken = validateFcmToken(destination.fcmToken);
          return fcmToken ? [{ platform:'android', fcmToken, updatedAt:Number(destination.updatedAt) || 0 }] : [];
        }
        if (destination?.platform === 'ios') {
          const apnsToken = validateApnsToken(destination.apnsToken);
          const apnsEnvironment = destination.apnsEnvironment === 'sandbox' ? 'sandbox' : 'production';
          return apnsToken ? [{ platform:'ios', apnsToken, apnsEnvironment, updatedAt:Number(destination.updatedAt) || 0 }] : [];
        }
        return [];
      }).slice(-10);
      accounts.set(entry[0], record);
      privateNumbers.set(record.privateNumber, entry[0]);
  }
  console.log(`Anonymous accounts loaded from ${source}: ${accounts.size}.`);
}

function loadAccounts() {
  try {
    if (fs.existsSync(ACCOUNTS_TMP_PATH)) fs.unlinkSync(ACCOUNTS_TMP_PATH);
    if (!fs.existsSync(ACCOUNTS_PATH)) return;
    hydrateAccounts(JSON.parse(fs.readFileSync(ACCOUNTS_PATH, 'utf8')), 'local fallback');
  } catch (e) { console.error('Anonymous account load failed:', e.message); }
}

function saveSnapshot({ log = true } = {}) {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    // Map values aren't JSON-serializable as-is — `members` is itself a
    // Map, so convert it to an array of [token, memberInfo] pairs per room.
    // Live-only state (open WebSocket objects in signalingSockets/wss) is
    // deliberately left out entirely; it can't be serialized and doesn't
    // need to be — every client already reconnects its own socket on
    // resume/focus regardless of whether the server restarted.
    const entries = Array.from(rooms.entries()).map(([code, room]) => [
      code,
      { ...room, members: Array.from(room.members.entries()) },
    ]);
    // Explicit, local guard around JUST this call — not relying on the
    // outer try/catch below to catch it implicitly. JSON.stringify here
    // builds ONE string containing every room's content; if
    // GLOBAL_BYTE_BUDGET is ever close enough to V8's MAX_STRING_LENGTH
    // cap (see its derivation above), this throws RangeError: Invalid
    // string length. That happens mid-shutdown, so the right response is
    // to skip the snapshot and let shutdown continue — a missed snapshot
    // just means rooms don't survive this particular restart, which is
    // recoverable; a crashed shutdown handler is not.
    let data;
    try {
      data = JSON.stringify(entries);
    } catch (e) {
      console.error(`Snapshot save SKIPPED — JSON.stringify failed (${e.message}). Continuing shutdown without a snapshot.`);
      return;
    }
    // Write to a .tmp file, fsync it to disk, THEN atomically rename it
    // onto the real path — rename is atomic within one filesystem (both
    // paths are in SNAPSHOT_DIR, so always the same one), so a SIGKILL at
    // any point up to and including mid-write leaves either a harmless
    // partial .tmp (never renamed, so SNAPSHOT_PATH — if it existed —
    // still holds the last snapshot that actually completed) or a fully
    // written new SNAPSHOT_PATH; there is no window where SNAPSHOT_PATH
    // itself can end up truncated or half-written. This file holds live
    // bearer tokens, so 0600 on both the tmp file (at creation) and the
    // final path (explicitly, afterward, regardless of whether the path
    // was just created or already existed — a bare mode on open only
    // applies to a brand-new file).
    const fd = fs.openSync(SNAPSHOT_TMP_PATH, 'w', 0o600);
    try {
      fs.writeSync(fd, data);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.chmodSync(SNAPSHOT_TMP_PATH, 0o600);
    fs.renameSync(SNAPSHOT_TMP_PATH, SNAPSHOT_PATH);
    fs.chmodSync(SNAPSHOT_PATH, 0o600);
    if (log) console.log(`Room checkpoint saved: ${entries.length} room(s) -> ${SNAPSHOT_PATH}`);
  } catch (e) {
    console.error('Snapshot save failed:', e.message);
  }
}

function loadSnapshot() {
  // A stray .tmp here means a previous save was interrupted before its
  // renameSync ever ran — it was never the live snapshot (the rename that
  // would have made it one never happened), so it's always safe to
  // discard. SNAPSHOT_PATH itself, if present, is unaffected by that
  // interruption — it's still whatever the last fully-completed save wrote
  // (or doesn't exist at all, if there was never a completed save).
  try {
    if (fs.existsSync(SNAPSHOT_TMP_PATH)) fs.unlinkSync(SNAPSHOT_TMP_PATH);
  } catch (e) {
    console.error('Stray snapshot .tmp cleanup failed:', e.message);
  }

  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return;
    const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
    let entries;
    try {
      entries = JSON.parse(raw);
    } catch (e) {
      // A corrupt file must start the server empty, not crash it into a
      // boot loop — removed too, so a later boot doesn't keep tripping
      // over the exact same unreadable file forever.
      console.error('Snapshot file is corrupt, discarding and starting empty:', e.message);
      try { fs.unlinkSync(SNAPSHOT_PATH); } catch (e2) {}
      return;
    }
    const now = Date.now();
    let restored = 0, expired = 0, droppedPushSubs = 0;
    for (const [roomCode, room] of entries) {
      // Standing links never expire on inactivity (see the sweep above) —
      // the same exemption has to apply here, or a Railway restart would
      // silently drop every Anon Link that had gone quiet for a day,
      // defeating the entire point of "doesn't expire."
      if (!room.persistent) {
        const ttl = room.isNamed ? NAMED_ROOM_TTL : ONE_TIME_ROOM_TTL;
        if (now - room.lastActivity > ttl) { expired++; continue; } // would've expired anyway — don't resurrect it
      }
      room.members = new Map(room.members);
      // Calls and sockets are live process state. A graceful-restart snapshot
      // must never resurrect a stale "active call" badge in the dashboard.
      room.activeCall = false;
      // A call mid-ring can't survive this any more than the process
      // itself can (the WebSocket carrying it is gone) — clear it so a
      // stale future timestamp doesn't incorrectly suppress a real ring
      // push after restart.
      room.ringingUntil = 0;
      room.nativeCallId = null;
      room.nativeCalleeToken = null;
      room.nativeInviteId = null;
      room.terminatedInviteId = null;
      room.terminatedInviteUntil = 0;
      // The ONLY path a pushSub can reach webpush.sendNotification without
      // ever having passed validatePushSubscription: a snapshot written by
      // an older deploy (before the allowlist existed, or before a later
      // tightening of it) restores whatever was serialized, verbatim, with
      // nothing else in the boot path re-checking it. Running every
      // restored member's pushSub back through the same validator used at
      // registration closes that gap — anything that no longer passes gets
      // nulled here rather than surviving into live memory.
      for (const member of room.members.values()) {
        if (member.pushSub && !validatePushSubscription(member.pushSub)) {
          member.pushSub = null;
          droppedPushSubs++;
        }
        if (member.apnsToken && !validateApnsToken(member.apnsToken)) member.apnsToken = null;
      }
      // Recomputed fresh rather than trusted from the snapshot — cheap
      // (one pass over this room's own msgs, capped at 100 entries) and
      // it's the one thing here actually worth not taking on faith: a
      // snapshot written by an older deploy from before room.byteSize
      // existed would restore as undefined otherwise, and pushRoomMsg's
      // `room.byteSize || 0` would silently start the count at 0 even
      // though room.msgs already holds real content — undercounting the
      // room's actual footprint until enough new traffic happened to
      // naturally correct it.
      room.byteSize = room.msgs.reduce((sum, msg) => sum + (msg.content ? msg.content.length : 0), 0);
      totalByteSize += room.byteSize;
      rooms.set(roomCode, room);
      restored++;
    }
    saveSnapshot({ log: false });
    console.log(`Room checkpoint restored: ${restored} room(s) (${expired} already expired, discarded). ${droppedPushSubs} stale/invalid push subscription(s) dropped on re-validation.`);
  } catch (e) {
    console.error('Snapshot load failed:', e.message);
  }
}

// Separate from SNAPSHOT_PATH on purpose: that checkpoint holds live rooms,
// while this file holds aggregate counters. Just running integers — no IP,
// room code, or
// timestamp is ever stored alongside them.
const ANALYTICS_PATH = path.join(SNAPSHOT_DIR, 'analytics.json');
let analytics = {
  roomsCreatedTemporary: 0,
  roomsCreatedPermanent: 0,
  joins: 0,
  messagesRelayed: 0,
  callsStarted: 0,
  callsAnswered: 0,
  daily: {},
};
let analyticsSaveTimer = null;

function trackAggregate(metric) {
  const date = new Date().toISOString().slice(0, 10);
  if (!analytics.daily || typeof analytics.daily !== 'object') analytics.daily = {};
  if (!analytics.daily[date]) {
    analytics.daily[date] = {
      vaultsTemporary: 0, vaultsPermanent: 0, joins: 0,
      messages: 0, callsStarted: 0, callsAnswered: 0,
    };
  }
  analytics.daily[date][metric] = (analytics.daily[date][metric] || 0) + 1;
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const key of Object.keys(analytics.daily)) if (key < cutoff) delete analytics.daily[key];
  scheduleAnalyticsSave();
}

function scheduleAnalyticsSave() {
  if (analyticsSaveTimer) return;
  analyticsSaveTimer = setTimeout(() => {
    analyticsSaveTimer = null;
    saveAnalytics();
  }, 1000);
  analyticsSaveTimer.unref();
}

function loadAnalytics() {
  try {
    if (fs.existsSync(ANALYTICS_PATH)) {
      analytics = { ...analytics, ...JSON.parse(fs.readFileSync(ANALYTICS_PATH, 'utf8')) };
    }
  } catch (e) { console.error('Analytics load failed:', e.message); }
}
function saveAnalytics() {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
    // Same mode-only-applies-on-creation caveat as the snapshot write above
    // — chmod explicitly for consistency, even though this file only ever
    // holds two aggregate counters, nothing sensitive.
    fs.writeFileSync(ANALYTICS_PATH, JSON.stringify(analytics), { mode: 0o600 });
    fs.chmodSync(ANALYTICS_PATH, 0o600);
  } catch (e) { console.error('Analytics save failed:', e.message); }
}
let roomCheckpointTimer = null;

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — saving final room checkpoint before exit...`);
  saveAnalytics();
  if (!postgresEnabled) saveAccounts();
  saveSnapshot();
  try { await postgresStore.close(); } catch (e) { console.error('PostgreSQL shutdown failed:', e.message); }
  srv.close(() => process.exit(0));
  // Belt-and-suspenders: if something (a lingering keep-alive connection,
  // an open WebSocket) keeps srv.close() from ever calling back, don't hang
  // the restart forever — the snapshot is already written by this point,
  // so there's nothing left worth waiting for.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => { shutdown('SIGTERM').catch(() => process.exit(1)); });
process.on('SIGINT', () => { shutdown('SIGINT').catch(() => process.exit(1)); });

async function bootstrap() {
  loadAnalytics();
  if (postgresStore.enabled) {
    // A configured production database is authoritative. Failure is fatal:
    // silently booting from an older volume copy would accept writes into a
    // split-brain store and make account deletion/recovery inconsistent.
    await postgresStore.initialize();
    postgresEnabled = true;
    hydrateAccounts(await postgresStore.loadAccounts(), 'PostgreSQL');
    console.log('PostgreSQL v2 account store ready.');
  } else {
    loadAccounts();
    console.warn('DATABASE_URL is not set — using the local account-store fallback.');
  }
  if (!process.env.SNAPSHOT_DIR) {
    console.warn('SNAPSHOT_DIR not set — durable room checkpoints will use local container disk, which does NOT survive a Railway deploy. Attach a Railway Volume (for example at /data) and set SNAPSHOT_DIR to that mount path.');
  }
  loadSnapshot();
  roomCheckpointTimer = setInterval(() => saveSnapshot({ log: false }), ROOM_CHECKPOINT_INTERVAL_MS);
  roomCheckpointTimer.unref();
  srv.listen(PORT, () => console.log(`Vaultlix on port ${PORT}`));
}

bootstrap().catch(err => {
  console.error('Vaultlix startup failed:', err.message);
  process.exit(1);
});
