const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const webpush = require('web-push');
const { WebSocketServer } = require('ws');

const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
// Named rooms are meant to persist for 4 days of inactivity, one-time
// (auto-generated code) rooms for 24 hours — per the product spec. This used
// to be a single flat 5-minute TTL for every room regardless of type, which
// silently deleted named rooms (and logged everyone out of them) within
// minutes of going idle. room.isNamed (set at creation) picks the right one.
const NAMED_ROOM_TTL = 4 * 24 * 60 * 60 * 1000;
const ONE_TIME_ROOM_TTL = 24 * 60 * 60 * 1000;

const rooms = new Map();

// VAPID keys identify this server to push services (Apple/Google/Mozilla's push
// endpoints) — they are NOT related to the E2E message encryption keys, and the
// server still never sees plaintext message content through this path (see the
// generic payload in /api/send below). Defaults are baked in so push works out
// of the box; for production hygiene, set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// as Railway environment variables instead and remove the private key from
// source. If you do override them, the client's VAPID_PUBLIC_KEY constant in
// index.html must be updated to match, or existing subscriptions will silently
// fail to deliver.
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BKd1545VKC8Tw1NB9SHbPaNGIBwKMft3oaH0USMJxrpUYEY_Mgcvn_XGL-BA6njGg-nts1z7YDsU-0txzezxfXA';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || 'aMEjVlR3d-zpiZgTSJBzCy8LJ-3QbtaF5T1aKeVLph8';
webpush.setVapidDetails('mailto:privacy@vaultlix.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Math.random() is not a CSPRNG — predictable enough in theory that it has
// no business generating anything used as a credential. This is used for
// room auth tokens (the bearer credential behind every /api/poll, /api/send,
// /api/read call for a room) and message ids, so it needs real randomness.
function uid() { return crypto.randomBytes(16).toString('hex'); }

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

function formatTimerLabel(seconds) {
  if (!seconds) return 'off';
  if (seconds < 60) return `${seconds} seconds`;
  if (seconds < 3600) { const m = Math.floor(seconds/60); return `${m} minute${m===1?'':'s'}`; }
  if (seconds < 86400) { const h = Math.floor(seconds/3600); return `${h} hour${h===1?'':'s'}`; }
  const days = Math.floor(seconds/86400); return `${days} day${days===1?'':'s'}`;
}

function code() {
  const w = ['amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember','fern','flame','frost','ghost','gold','grove','haven','iron','jade','karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova','oak','opal','pearl','pine','rain','raven','reed','ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silver','slate','smoke','snow','spark','star','steel','storm','tide','timber','topaz','vault','veil','wave','wild','wind','wolf'];
  const p = () => w[Math.floor(Math.random()*w.length)];
  const nn = () => Math.floor(Math.random()*90+10);
  // A few different shapes instead of always "word-word-NN" — every
  // auto-generated code looking visually identical made them blur together
  // for anyone juggling a few open rooms at once.
  const formats = [
    () => `${p()}-${p()}-${nn()}`,
    () => `${p()}-${nn()}-${p()}`,
    () => `${nn()}-${p()}-${p()}`,
    () => `${p()}-${p()}-${p()}`,
  ];
  return formats[Math.floor(Math.random()*formats.length)]();
}

setInterval(() => {
  const now = Date.now();
  for (const [k,r] of rooms) {
    const ttl = r.isNamed ? NAMED_ROOM_TTL : ONE_TIME_ROOM_TTL;
    if (now - r.lastActivity > ttl) { rooms.delete(k); console.log(`Room ${k} expired`); }
  }
}, 30000);

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
  for (const room of rooms.values()) {
    if (!room.deleteTimer) continue;
    for (const msg of room.msgs) {
      if (msg.type !== 'message' || msg.deleted || !msg.readAt) continue;
      if (now - msg.readAt >= room.deleteTimer * 1000) {
        msg.content = null;
        msg.deleted = true;
        msg.deletionSeq = ++room.deletionSeq;
      }
    }
  }
}, 5000);

function res200(res, data) {
  res.writeHead(200, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*', 'Cache-Control':'no-cache' });
  res.end(JSON.stringify(data));
}
function resErr(res, msg, status=400) {
  res.writeHead(status, { 'Content-Type':'application/json', 'Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify({ error: msg }));
}

function serveStatic(req, res) {
  let url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  // Extension-less route for the install page — without this, a request for
  // "/install" (no ".html") misses the readFile below, falls through to the
  // SPA catch-all, and silently serves the main app instead of install.html.
  if (url === '/install') url = '/install.html';
  if (!url.startsWith('/') || url.includes('..')) { res.writeHead(403); res.end(); return; }
  fs.readFile(path.join(__dirname,'../client',url), (err,data) => {
    if (err) {
      fs.readFile(path.join(__dirname,'../client/index.html'), (e,d) => {
        if (e) { res.writeHead(404); res.end(); return; }
        res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); res.end(d);
      }); return;
    }
    const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png','.svg':'image/svg+xml'};
    res.writeHead(200,{'Content-Type':t[path.extname(url)]||'text/plain'}); res.end(data);
  });
}

// Migrated from valuted.in to vaultlix.com. Both domains need to stay
// attached to this same Railway service (don't remove valuted.in from
// Railway's domain settings) — the redirect below only fires if a request
// for the old domain actually reaches this process.
const OLD_DOMAINS = new Set(['valuted.in', 'www.valuted.in']);
const NEW_DOMAIN = 'vaultlix.com';

const srv = http.createServer((req, res) => {
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
    res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
    res.end();
    return;
  }
  if (proto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  }
  if (req.method==='OPTIONS') {
    res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Methods':'GET,POST','Access-Control-Allow-Headers':'Content-Type'});
    res.end(); return;
  }
  const u = new URL(req.url, 'http://x');
  if (!u.pathname.startsWith('/api/')) { serveStatic(req,res); return; }
  let body='';
  req.on('data',d=>body+=d);
  req.on('end',()=>{
    let d={};
    try { if(body) d=JSON.parse(body); } catch{}
    // api() is async now (password hashing awaits scrypt) but still responds
    // entirely through the res object rather than a return value, so this
    // stays fire-and-forget — just needs a catch so a thrown error (a
    // malformed password field, scrypt failing, etc.) can't crash the
    // process or hang the request with no response ever sent.
    api(u.pathname, req.method, d, u.searchParams, res, clientIp(req)).catch(err => {
      console.error('API error:', err.message);
      try { resErr(res, 'Internal error.', 500); } catch(e) {}
    });
  });
});

async function api(path, method, d, p, res, ip) {

  // POST /api/create
  if (path==='/api/create' && method==='POST') {
    // 8 rooms per 10 minutes per IP — generous for anyone genuinely opening
    // a few conversations (this app's own 5-open-rooms-at-once cap is the
    // practical ceiling for a real user anyway), but enough to stop a
    // script from spam-creating rooms, which had zero limit before this.
    if (rateLimited(`create:${ip}`, 8, 10 * 60 * 1000)) {
      return resErr(res, 'Too many rooms created from this connection — try again in a few minutes.', 429);
    }
    const namedCode = d.namedCode ? d.namedCode.replace(/[^a-z0-9-]/g,'-').slice(0,40) : null;
    if (namedCode && rooms.has(namedCode)) return resErr(res,`Room "${namedCode}" already exists.`,409);
    const roomCode = namedCode || code();
    const token = uid();
    const name = (d.name||'Stranger').slice(0,24);
    const passwordHash = d.password ? await hashPassword(d.password) : null;
    rooms.set(roomCode, {
      lastActivity: Date.now(),
      isNamed: !!namedCode,
      deleteTimer: parseInt(d.deleteTimer)||0,
      passwordHash,
      seq: 0,          // global message sequence counter
      reactionSeq: 0,  // separate counter so reaction updates can be synced like read receipts
      deletionSeq: 0,  // same pattern again, for "delete for everyone" — see /api/delete-message
      members: new Map([[token, { name, pubKey: d.pubKey||null, lastSeen: Date.now() }]]),
      msgs: [],        // { seq, id, type, from, name, content, time, ts, deliveredAt, readAt, reactions, reactionSeq }
    });
    console.log(`Room created: ${roomCode}`);
    return res200(res, { code: roomCode, token, name, deleteTimer: parseInt(d.deleteTimer)||0 });
  }

  // POST /api/join
  if (path==='/api/join' && method==='POST') {
    const roomCode = (d.code||'').toLowerCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return resErr(res,'Room not found.',404);

    // Rejoin with saved token — an existing session token is itself the
    // credential for continued access, so this branch intentionally comes
    // before the password check below. Password re-verification used to
    // apply here too, which silently broke reconnecting to any
    // password-protected room: a page reload never re-sends the password
    // (it isn't kept in memory across a reload), so every reload of one of
    // these rooms was rejected as "Incorrect password" even with a
    // perfectly valid saved session.
    if (d.token && room.members.has(d.token)) {
      const m = room.members.get(d.token);
      m.lastSeen = Date.now();
      if (d.pubKey) m.pubKey = d.pubKey;
      room.lastActivity = Date.now();
      // peerName rides along now too — without it, a reconnecting client had
      // nothing to show in its header until its first regular poll came
      // back, which meant the raw room code sat there visibly if that poll
      // was even slightly delayed.
      let peerPubKey = null, peerName = null;
      for (const [t,mb] of room.members) if (t!==d.token) { peerPubKey = mb.pubKey; peerName = mb.name; }
      return res200(res, { code: roomCode, token: d.token, name: m.name, isReconnect: true, peerPubKey, peerName, deleteTimer: room.deleteTimer });
    }

    if (room.passwordHash && !(await verifyPassword(d.password, room.passwordHash))) return resErr(res,'Incorrect password.',403);

    // Clean stale members (disconnected without calling /api/leave)
    const staleThreshold = Date.now() - 30000; // 30 seconds
    for (const [t, m] of room.members) {
      if (m.lastSeen < staleThreshold) room.members.delete(t);
    }
    if (room.members.size >= 2) return resErr(res,'Room is full.',403);
    const token = uid();
    const name = (d.name||'Stranger').slice(0,24);
    room.members.set(token, { name, pubKey: d.pubKey||null, lastSeen: Date.now() });
    room.lastActivity = Date.now();

    // System message — tagged with `from` so the poll filter (which already
    // excludes a caller's own messages) also excludes this one for the
    // joiner themselves. Without it, system messages had no sender at all,
    // so the "X joined" announcement got echoed back to X's own client too
    // — confusing since the app had just told them "You're X" a moment
    // earlier. The other member still gets it normally, which is the whole
    // point of the message.
    room.msgs.push({ seq: ++room.seq, id: uid(), type:'system', content:`${name} joined`, ts: Date.now(), from: token });

    let peerPubKey = null;
    for (const [t,mb] of room.members) if (t!==token) peerPubKey = mb.pubKey;
    console.log(`${name} joined ${roomCode}`);
    return res200(res, { code: roomCode, token, name, peerPubKey, deleteTimer: room.deleteTimer });
  }

  // POST /api/send
  if (path==='/api/send' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return resErr(res,'Room not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in room.',403);
    // Rate-limited by token (the authenticated sender), not IP — two people
    // in the same room can legitimately share an IP (same NAT/network), and
    // punishing by IP would hit the wrong person. 20 messages per 10
    // seconds is far above normal typing speed but stops a flooding script;
    // there was no limit of any kind here before this.
    if (rateLimited(`send:${d.token}`, 20, 10 * 1000)) {
      return resErr(res, 'Sending too fast — slow down a moment.', 429);
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
    const seq = ++room.seq;
    room.msgs.push({ seq, id: msgId, type:'message', from: d.token, name: m.name, content: d.content, time, ts: Date.now(), deliveredAt: null, readAt: null, reactions: {}, reactionSeq: 0 });
    // Trim — keep last 100 messages but seq numbers never reset. Lowered
    // from 300: applies regardless of whether disappearing-message timers
    // are on, so even a room without them retains less on the server.
    if (room.msgs.length > 100) room.msgs.splice(0, room.msgs.length-100);

    // Best-effort push notification to the peer if they've subscribed. The
    // server can't decrypt d.content (E2E), so the payload is deliberately
    // generic — only the sender's already-plaintext display name goes out,
    // never message content. Fire-and-forget: a slow/failed push must never
    // delay the send response.
    for (const [t, mb] of room.members) {
      if (t !== d.token && mb.pushSub) {
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
        webpush.sendNotification(mb.pushSub, payload, { urgency: 'high', TTL: 60 }).catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) mb.pushSub = null; // subscription expired/revoked
          else console.warn('push send failed:', err.statusCode, err.body || err.message);
        });

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
          if (!mb.pushSub) return; // already known-dead from the first attempt
          webpush.sendNotification(mb.pushSub, payload, { urgency: 'high', TTL: 30 }).catch(err => {
            if (err.statusCode === 404 || err.statusCode === 410) mb.pushSub = null;
            else console.warn('push retry send failed:', err.statusCode, err.body || err.message);
          });
        }, 6000);
      }
    }

    return res200(res, { ok: true, msgId, seq });
  }

  // POST /api/push-subscribe — store this member's Web Push subscription
  if (path==='/api/push-subscribe' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in room.',403);
    const m = room.members.get(d.token);
    m.pushSub = d.subscription || null;
    room.lastActivity = Date.now();
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
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in room.',403);
    if (!process.env.CF_TURN_KEY_ID || !process.env.CF_TURN_KEY_API_TOKEN) {
      console.error('TURN credentials requested but CF_TURN_KEY_ID/CF_TURN_KEY_API_TOKEN not set.');
      return resErr(res,'Calling is not configured.',503);
    }
    try {
      const cfRes = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
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
    if (!room) return resErr(res,'Room not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in room.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId);
    if (!msg) return resErr(res,'Message not found.',404);
    if (!msg.reactions) msg.reactions = {};
    if (d.emoji) msg.reactions[d.token] = String(d.emoji).slice(0,8);
    else delete msg.reactions[d.token];
    msg.reactionSeq = ++room.reactionSeq;
    room.lastActivity = Date.now();
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
    if (!room) return resErr(res,'Room not found.',404);
    if (!room.members.has(d.token)) return resErr(res,'Not in room.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId && mm.type === 'message');
    if (!msg) return resErr(res,'Message not found.',404);
    if (msg.from !== d.token) return resErr(res,'Only the sender can delete this for everyone.',403);
    msg.content = null;
    msg.deleted = true;
    msg.deletionSeq = ++room.deletionSeq;
    room.lastActivity = Date.now();
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
    if (!room) return resErr(res,'Room not found.',404);
    const m = room.members.get(d.token);
    if (!m) return resErr(res,'Not in room.',403);
    const val = parseInt(d.deleteTimer);
    room.deleteTimer = (isNaN(val) || val < 0) ? 0 : val;
    room.lastActivity = Date.now();
    room.msgs.push({
      seq: ++room.seq, id: uid(), type:'system',
      content: room.deleteTimer
        ? `${m.name} set disappearing messages to ${formatTimerLabel(room.deleteTimer)}`
        : `${m.name} turned off disappearing messages`,
      ts: Date.now(),
    });
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
    if (!room) return resErr(res,'Room not found.',404);
    const m = room.members.get(d.token);
    if (!m) return resErr(res,'Not in room.',403);
    room.msgs = [];
    room.clearedAt = Date.now();
    room.lastActivity = Date.now();
    room.msgs.push({ seq: ++room.seq, id: uid(), type:'system', content:`${m.name} cleared the chat`, ts: Date.now() });
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
    if (!room.members.has(token)) return resErr(res,'Not in room.',403);

    const m = room.members.get(token);
    m.lastSeen = Date.now();
    room.lastActivity = Date.now();

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
    for (const msg of newMsgs) {
      if (msg.type==='message' && msg.from !== token && !msg.deliveredAt) msg.deliveredAt = Date.now();
    }

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

    return res200(res, { messages: newMsgs, peerName, peerOnline, peerPubKey, readReceipts, reactionUpdates, deletions, deleteTimer: room.deleteTimer, clearedAt: room.clearedAt || 0 });
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
    if (!room || !room.members.has(d.token)) return resErr(res,'Not in room.',403);
    const msg = room.msgs.find(mm => mm.id === d.msgId);
    if (msg && msg.type === 'message' && !msg.deliveredAt) {
      msg.deliveredAt = Date.now();
      room.lastActivity = Date.now();
    }
    return res200(res, { ok: true });
  }

  // POST /api/read
  if (path==='/api/read' && method==='POST') {
    const room = rooms.get(d.code);
    if (room && room.members.has(d.token) && Array.isArray(d.msgIds)) {
      for (const msg of room.msgs) if (d.msgIds.includes(msg.id) && !msg.readAt) msg.readAt = Date.now();
      room.lastActivity = Date.now();
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
    }
    return res200(res, { ok: true });
  }

  // POST /api/check_typing — same reasoning as /api/poll above: this used
  // to be a GET with code/token as URL query parameters, fired every 2.5s
  // while a room is open, which meant the same standard infrastructure
  // access-log exposure applied here too. Moved to POST + JSON body.
  if (path==='/api/check_typing' && method==='POST') {
    const room = rooms.get(d.code);
    if (!room) return res200(res,{typing:false});
    const now = Date.now();
    let typing = false;
    for (const [t,m] of room.members) if (t!==d.token && m.typing && now-m.typing<3000) typing=true;
    return res200(res,{typing});
  }

  // POST /api/leave
  if (path==='/api/leave' && method==='POST') {
    const room = rooms.get(d.code);
    if (room) {
      room.members.delete(d.token);
      room.msgs.push({ seq:++room.seq, id:uid(), type:'system', content:`${d.name} left`, ts:Date.now() });
      if (room.members.size===0) rooms.delete(d.code);
      else room.lastActivity = Date.now();
    }
    return res200(res,{ok:true});
  }

  // POST /api/close
  if (path==='/api/close' && method==='POST') {
    rooms.delete(d.code);
    return res200(res,{ok:true});
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
const wss = new WebSocketServer({ noServer: true });

// One live socket per participant, keyed by their room token — not by room
// code, since a signaling message needs to reach one specific person, not
// broadcast to a room. Same token space /api/poll already authenticates
// against; nothing new to trust here.
const signalingSockets = new Map();

srv.on('upgrade', (req, socket, head) => {
  let u;
  try { u = new URL(req.url, 'http://x'); } catch (e) { socket.destroy(); return; }
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

wss.on('connection', (ws) => {
  ws.authenticated = false;

  // Clean up on close regardless of whether auth ever completed — if it
  // didn't, ws.token was never set, so the signalingSockets lookup below is
  // just a harmless no-op.
  ws.on('close', () => {
    if (ws.token && signalingSockets.get(ws.token) === ws) signalingSockets.delete(ws.token);
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

    // A reconnect (network switch, tab backgrounded and resumed, etc.)
    // replaces the old socket for this token rather than stacking up dead
    // connections that'd otherwise both "successfully" receive a relay.
    const existing = signalingSockets.get(token);
    if (existing && existing !== ws) { try { existing.close(4002, 'Replaced by new connection'); } catch(e) {} }
    signalingSockets.set(token, ws);
    // Room code + a truncated token only — enough to confirm connectivity
    // during testing without logging anything that identifies a person or
    // any message/signal content, same posture as the existing "Room
    // created: <code>" log below.
    console.log(`Signal socket connected: room ${roomCode} token ${token.slice(0,6)}…`);

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

      const room2 = rooms.get(roomCode);
      if (!room2 || !room2.members.has(token)) { try { ws.close(4001, 'No longer in room'); } catch(e) {} return; }
      room2.lastActivity = Date.now();

      // 1:1 rooms only ever have one other member — relay to them if they
      // currently have a live socket. If they don't (call app not open on
      // their end right now), the message is simply dropped; there's no
      // queue, no retry, no persistence — same "never stored" posture as
      // everything else in this app.
      for (const [tok, peerMember] of room2.members) {
        if (tok === token) continue;
        const peerWs = signalingSockets.get(tok);
        if (peerWs && peerWs.readyState === peerWs.OPEN) {
          // sessionId is a random per-page-load nonce the client uses to tell
          // "the peer's session actually restarted" apart from "this looks
          // like a replay" in its own sequence-number check — meaningless to
          // this server, just forwarded along with everything else opaque.
          peerWs.send(JSON.stringify({ type: msg2.type, from: token, sessionId: msg2.sessionId, envelope: msg2.envelope }));
          // `msg2.type` only — envelope is opaque ciphertext this process
          // never decrypts, so there's nothing content-bearing to log here.
          console.log(`Signal relayed: room ${roomCode} type ${msg2.type}`);
        } else {
          console.log(`Signal dropped (peer not connected): room ${roomCode} type ${msg2.type}`);
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
          const alreadyRinging = room2.ringingUntil && room2.ringingUntil > now;
          room2.ringingUntil = now + 30000; // matches client CALL_RING_TIMEOUT_MS
          if (!alreadyRinging && peerMember.pushSub) {
            const caller = room2.members.get(token);
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
              code: roomCode,
            });
            webpush.sendNotification(peerMember.pushSub, payload, { urgency: 'high', TTL: 30 }).catch(err => {
              if (err.statusCode === 404 || err.statusCode === 410) peerMember.pushSub = null;
              else console.warn('call push send failed:', err.statusCode, err.body || err.message);
            });

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
            setTimeout(() => {
              if (room2.ringingUntil !== ringMarker || room2.ringingUntil <= Date.now()) return;
              if (!peerMember.pushSub) return; // already known-dead from the first attempt
              webpush.sendNotification(peerMember.pushSub, payload, { urgency: 'high', TTL: 15 }).catch(err => {
                if (err.statusCode === 404 || err.statusCode === 410) peerMember.pushSub = null;
                else console.warn('call push retry send failed:', err.statusCode, err.body || err.message);
              });
            }, 5000);
          }
        } else if (msg2.type === 'call-accept' || msg2.type === 'call-decline' || msg2.type === 'call-busy') {
          room2.ringingUntil = 0;
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
          const wasStillRinging = room2.ringingUntil && room2.ringingUntil > now;
          room2.ringingUntil = 0;
          if (wasStillRinging && peerMember.pushSub) {
            const caller = room2.members.get(token);
            const missedPayload = JSON.stringify({
              title: 'Vaultlix',
              body: caller && caller.name ? `Missed call from ${caller.name}` : 'Missed call',
              tag: `vaultlix-missed-${roomCode}-${now}`,
              isCall: false,
              code: roomCode,
            });
            webpush.sendNotification(peerMember.pushSub, missedPayload, { urgency: 'high', TTL: 3600 }).catch(err => {
              if (err.statusCode === 404 || err.statusCode === 410) peerMember.pushSub = null;
              else console.warn('missed-call push send failed:', err.statusCode, err.body || err.message);
            });
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
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) {}
  });
}, 25000);

// ── SHUTDOWN SNAPSHOT ─────────────────────────────────────────────────────
// `rooms` lives only in process memory — by design, there's no database.
// The cost of that is real: any process restart (a deploy, a manual
// restart, Railway recycling the container) used to wipe every open room
// and any message not yet delivered, with nothing to signal either party.
// This doesn't fix that for a hard crash or OOM kill — the process never
// gets a chance to run any code in that case, nothing short of a
// continuously-replicated store like Redis could. What it does fix is the
// far more common case: a graceful restart, where the process receives
// SIGTERM and gets a brief moment to act before it actually exits. On that
// signal, serialize the whole `rooms` Map to disk once; on boot, reload it
// (skipping anything that would already have expired anyway) and delete the
// file so a later, truly-fresh boot never finds a stale leftover.
//
// SNAPSHOT_DIR must point at storage that survives the *container* being
// torn down and recreated, not just the process inside it — i.e. a Railway
// Volume, not the container's own ephemeral disk. Without a Volume attached
// and SNAPSHOT_DIR pointed at its mount path, this still runs safely (falls
// back to a local folder next to the server code) but a real deploy will
// still lose rooms, same as before. See the boot-time log line below.
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || path.join(__dirname, '.data');
const SNAPSHOT_PATH = path.join(SNAPSHOT_DIR, 'rooms-snapshot.json');

function saveSnapshot() {
  try {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
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
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(entries));
    console.log(`Snapshot saved: ${entries.length} room(s) -> ${SNAPSHOT_PATH}`);
  } catch (e) {
    console.error('Snapshot save failed:', e.message);
  }
}

function loadSnapshot() {
  try {
    if (!fs.existsSync(SNAPSHOT_PATH)) return;
    const entries = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    const now = Date.now();
    let restored = 0, expired = 0;
    for (const [roomCode, room] of entries) {
      const ttl = room.isNamed ? NAMED_ROOM_TTL : ONE_TIME_ROOM_TTL;
      if (now - room.lastActivity > ttl) { expired++; continue; } // would've expired anyway — don't resurrect it
      room.members = new Map(room.members);
      // A call mid-ring can't survive this any more than the process
      // itself can (the WebSocket carrying it is gone) — clear it so a
      // stale future timestamp doesn't incorrectly suppress a real ring
      // push after restart.
      room.ringingUntil = 0;
      rooms.set(roomCode, room);
      restored++;
    }
    fs.unlinkSync(SNAPSHOT_PATH); // one-shot — never let a later normal boot see a stale file
    console.log(`Snapshot restored: ${restored} room(s) (${expired} already expired, discarded).`);
  } catch (e) {
    console.error('Snapshot load failed:', e.message);
  }
}

if (!process.env.SNAPSHOT_DIR) {
  console.warn('SNAPSHOT_DIR not set — shutdown snapshots will use local container disk, which does NOT survive a Railway deploy (only survives if the same container process restarts in place). To make rooms survive real deploys: attach a Railway Volume to this service, mount it (e.g. at /data), and set the SNAPSHOT_DIR variable to that mount path.');
}
loadSnapshot();

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — saving snapshot before exit...`);
  saveSnapshot();
  srv.close(() => process.exit(0));
  // Belt-and-suspenders: if something (a lingering keep-alive connection,
  // an open WebSocket) keeps srv.close() from ever calling back, don't hang
  // the restart forever — the snapshot is already written by this point,
  // so there's nothing left worth waiting for.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

srv.listen(PORT, () => console.log(`Vaultlix on port ${PORT}`));
