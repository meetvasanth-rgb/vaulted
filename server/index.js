const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const webpush = require('web-push');
const { WebSocketServer } = require('ws');

const scryptAsync = promisify(crypto.scrypt);

const PORT = process.env.PORT || 3000;
// Named rooms are meant to persist for 7 days of inactivity, one-time
// (auto-generated code) rooms for 24 hours — per the product spec. This used
// to be a single flat 5-minute TTL for every room regardless of type, which
// silently deleted named rooms (and logged everyone out of them) within
// minutes of going idle. room.isNamed (set at creation) picks the right one.
const NAMED_ROOM_TTL = 7 * 24 * 60 * 60 * 1000;
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
  return `${p()}-${p()}-${Math.floor(Math.random()*90+10)}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [k,r] of rooms) {
    const ttl = r.isNamed ? NAMED_ROOM_TTL : ONE_TIME_ROOM_TTL;
    if (now - r.lastActivity > ttl) { rooms.delete(k); console.log(`Room ${k} expired`); }
  }
}, 30000);

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
    api(u.pathname, req.method, d, u.searchParams, res).catch(err => {
      console.error('API error:', err.message);
      try { resErr(res, 'Internal error.', 500); } catch(e) {}
    });
  });
});

async function api(path, method, d, p, res) {

  // POST /api/create
  if (path==='/api/create' && method==='POST') {
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
      let peerPubKey = null;
      for (const [t,mb] of room.members) if (t!==d.token) peerPubKey = mb.pubKey;
      return res200(res, { code: roomCode, token: d.token, name: m.name, isReconnect: true, peerPubKey, deleteTimer: room.deleteTimer });
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
    // Trim — keep last 300 messages but seq numbers never reset
    if (room.msgs.length > 300) room.msgs.splice(0, room.msgs.length-300);

    // Best-effort push notification to the peer if they've subscribed. The
    // server can't decrypt d.content (E2E), so the payload is deliberately
    // generic — only the sender's already-plaintext display name goes out,
    // never message content. Fire-and-forget: a slow/failed push must never
    // delay the send response.
    for (const [t, mb] of room.members) {
      if (t !== d.token && mb.pushSub) {
        const payload = JSON.stringify({ title: 'Vaultlix', body: `New message from ${m.name}`, tag: d.code });
        // urgency:'high' asks the push service (Apple/Google's relay) to wake the
        // device promptly instead of batching/deferring — matters most on iOS,
        // which is more aggressive about delaying "normal" priority pushes to a
        // locked, idle device. TTL is a 60s delivery window if the device is briefly
        // unreachable (e.g. no signal), after which the push service drops it.
        webpush.sendNotification(mb.pushSub, payload, { urgency: 'high', TTL: 60 }).catch(err => {
          if (err.statusCode === 404 || err.statusCode === 410) mb.pushSub = null; // subscription expired/revoked
          else console.warn('push send failed:', err.statusCode, err.body || err.message);
        });
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

  // GET /api/poll — SIMPLE: return all messages with seq > clientLastSeq that are not from this user
  if (path==='/api/poll' && method==='GET') {
    const roomCode = p.get('code');
    const token = p.get('token');
    const clientLastSeq = parseInt(p.get('lastSeq')||'0');
    const lastReceiptSeq = parseInt(p.get('lastReceiptSeq')||'0');
    const lastReactionSeq = parseInt(p.get('lastReactionSeq')||'0');
    const lastDeletionSeq = parseInt(p.get('lastDeletionSeq')||'0');
    // full=1 is only ever sent once, right after a reload, to rebuild the
    // chat log from scratch (the client never persists message content
    // locally — only the room session and a small expiry ledger). Normal
    // incremental polling never sets this and keeps excluding the caller's
    // own messages exactly as before, since the client already has those
    // from its own optimistic send.
    const includeOwn = p.get('full') === '1';
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

    // Mark delivered
    for (const msg of newMsgs) {
      if (msg.type==='message' && !msg.deliveredAt) msg.deliveredAt = Date.now();
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

    return res200(res, { messages: newMsgs, peerName, peerOnline, peerPubKey, readReceipts, reactionUpdates, deletions, deleteTimer: room.deleteTimer });
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

  // GET /api/check_typing
  if (path==='/api/check_typing' && method==='GET') {
    const room = rooms.get(p.get('code'));
    if (!room) return res200(res,{typing:false});
    const now = Date.now();
    let typing = false;
    for (const [t,m] of room.members) if (t!==p.get('token') && m.typing && now-m.typing<3000) typing=true;
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

  const code = (u.searchParams.get('code') || '').toLowerCase().trim();
  const token = u.searchParams.get('token') || '';
  const room = rooms.get(code);
  if (!room || !token || !room.members.has(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.roomCode = code;
    ws.token = token;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  const { roomCode, token } = ws;

  // A reconnect (network switch, tab backgrounded and resumed, etc.)
  // replaces the old socket for this token rather than stacking up dead
  // connections that'd otherwise both "successfully" receive a relay.
  const existing = signalingSockets.get(token);
  if (existing && existing !== ws) { try { existing.close(4002, 'Replaced by new connection'); } catch(e) {} }
  signalingSockets.set(token, ws);

  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.type !== 'string' || typeof msg.envelope !== 'string') return;

    const room = rooms.get(roomCode);
    if (!room || !room.members.has(token)) { try { ws.close(4001, 'No longer in room'); } catch(e) {} return; }
    room.lastActivity = Date.now();

    // 1:1 rooms only ever have one other member — relay to them if they
    // currently have a live socket. If they don't (call app not open on
    // their end right now), the message is simply dropped; there's no
    // queue, no retry, no persistence — same "never stored" posture as
    // everything else in this app.
    for (const [tok] of room.members) {
      if (tok === token) continue;
      const peerWs = signalingSockets.get(tok);
      if (peerWs && peerWs.readyState === peerWs.OPEN) {
        peerWs.send(JSON.stringify({ type: msg.type, from: token, envelope: msg.envelope }));
      }
      break;
    }
  });

  ws.on('close', () => {
    if (signalingSockets.get(token) === ws) signalingSockets.delete(token);
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

srv.listen(PORT, () => console.log(`Vaultlix on port ${PORT}`));
