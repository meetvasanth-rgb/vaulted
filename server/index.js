const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ROOM_TTL = 5 * 60 * 1000;

const rooms = new Map();

function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

function code() {
  const w = ['amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember','fern','flame','frost','ghost','gold','grove','haven','iron','jade','karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova','oak','opal','pearl','pine','rain','raven','reed','ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silver','slate','smoke','snow','spark','star','steel','storm','tide','timber','topaz','vault','veil','wave','wild','wind','wolf'];
  const p = () => w[Math.floor(Math.random()*w.length)];
  return `${p()}-${p()}-${Math.floor(Math.random()*90+10)}`;
}

setInterval(() => {
  const now = Date.now();
  for (const [k,r] of rooms) if (now - r.lastActivity > ROOM_TTL) { rooms.delete(k); console.log(`Room ${k} expired`); }
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
    const t={'.html':'text/html','.js':'text/javascript','.css':'text/css','.ico':'image/x-icon'};
    res.writeHead(200,{'Content-Type':t[path.extname(url)]||'text/plain'}); res.end(data);
  });
}

const srv = http.createServer((req, res) => {
  // Railway's edge terminates TLS and forwards decrypted traffic to this
  // process, setting x-forwarded-proto so we can tell which scheme the
  // visitor actually used. Force the upgrade to https, and send HSTS once
  // we know a request came in over https so browsers remember to always
  // use https for this host, even from an old http:// link.
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
      deleteTimer: parseInt(d.deleteTimer)||0,
      password: d.password||null,
      seq: 0,          // global message sequence counter
      members: new Map([[token, { name, pubKey: d.pubKey||null, lastSeen: Date.now() }]]),
      msgs: [],        // { seq, id, type, from, name, content, time, ts, deliveredAt, readAt }
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

    // System message
    room.msgs.push({ seq: ++room.seq, id: uid(), type:'system', content:`${name} joined`, ts: Date.now() });

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
    const clientMsgId = typeof d.msgId === 'string' ? d.msgId.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,64) : '';
    const msgId = clientMsgId || uid();
    const seq = ++room.seq;
    room.msgs.push({ seq, id: msgId, type:'message', from: d.token, name: m.name, content: d.content, time, ts: Date.now(), deliveredAt: null, readAt: null });
    // Trim — keep last 300 messages but seq numbers never reset
    if (room.msgs.length > 300) room.msgs.splice(0, room.msgs.length-300);
    return res200(res, { ok: true, msgId, seq });
  }

  // GET /api/poll — SIMPLE: return all messages with seq > clientLastSeq that are not from this user
  if (path==='/api/poll' && method==='GET') {
    const roomCode = p.get('code');
    const token = p.get('token');
    const clientLastSeq = parseInt(p.get('lastSeq')||'0');
    const lastReceiptSeq = parseInt(p.get('lastReceiptSeq')||'0');
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

    // Messages since clientLastSeq, excluding own
    const newMsgs = room.msgs.filter(msg => msg.seq > clientLastSeq && msg.from !== token);

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

    return res200(res, { messages: newMsgs, peerName, peerOnline, peerPubKey, readReceipts, deleteTimer: room.deleteTimer });
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
