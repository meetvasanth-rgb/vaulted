const http = require('http');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

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
webpush.setVapidDetails('mailto:privacy@valuted.in', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

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

const srv = http.createServer((req, res) => {
  // Railway's edge terminates TLS and forwards decrypted traffic to this
  // process, setting x-forwarded-proto so we can tell which scheme the
  // visitor actually used. Confirmed by testing: valuted.in currently
  // serves the full site over plain http:// with no redirect to https —
  // that's what Chrome is flagging as "Not Secure" (whether or not https
  // itself is configured correctly). Force the upgrade here, and send HSTS
  // once we know a request came in over https so browsers remember to use
  // https for this host next time, even if someone lands on an old http:// link.
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
    api(u.pathname, req.method, d, u.searchParams, res);
  });
});

function api(path, method, d, p, res) {

  // POST /api/create
  if (path==='/api/create' && method==='POST') {
    const namedCode = d.namedCode ? d.namedCode.replace(/[^a-z0-9-]/g,'-').slice(0,40) : null;
    if (namedCode && rooms.has(namedCode)) return resErr(res,`Room "${namedCode}" already exists.`,409);
    const roomCode = namedCode || code();
    const token = uid();
    const name = (d.name||'Stranger').slice(0,24);
    rooms.set(roomCode, {
      lastActivity: Date.now(),
      isNamed: !!namedCode,
      deleteTimer: parseInt(d.deleteTimer)||0,
      password: d.password||null,
      seq: 0,          // global message sequence counter
      reactionSeq: 0,  // separate counter so reaction updates can be synced like read receipts
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
    if (room.password && room.password !== (d.password||null)) return resErr(res,'Incorrect password.',403);

    // Rejoin with saved token
    if (d.token && room.members.has(d.token)) {
      const m = room.members.get(d.token);
      m.lastSeen = Date.now();
      if (d.pubKey) m.pubKey = d.pubKey;
      room.lastActivity = Date.now();
      let peerPubKey = null;
      for (const [t,mb] of room.members) if (t!==d.token) peerPubKey = mb.pubKey;
      return res200(res, { code: roomCode, token: d.token, name: m.name, isReconnect: true, peerPubKey, deleteTimer: room.deleteTimer });
    }

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
        const payload = JSON.stringify({ title: 'Vaulted', body: `New message from ${m.name}`, tag: d.code });
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
    const newMsgs = room.msgs.filter(msg => msg.seq > clientLastSeq && (includeOwn || msg.from !== token));

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

    return res200(res, { messages: newMsgs, peerName, peerOnline, peerPubKey, readReceipts, reactionUpdates, deleteTimer: room.deleteTimer });
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

srv.listen(PORT, () => console.log(`Vaulted on port ${PORT}`));
