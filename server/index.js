const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ROOM_TTL = 5 * 60 * 1000;
const MAX_MESSAGES = 500; // higher limit, no shift() needed

const rooms = new Map();

function generateCode() {
  const w = ['amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember','fern','flame','frost','ghost','glass','gold','grove','haven','iron','jade','karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova','oak','opal','orbit','pearl','pine','prism','rain','raven','reed','ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silk','silver','slate','smoke','snow','spark','star','steel','storm','tide','timber','topaz','vale','vault','veil','wave','wild','wind','wolf'];
  const p = () => w[Math.floor(Math.random() * w.length)];
  return `${p()}-${p()}-${Math.floor(Math.random() * 90 + 10)}`;
}

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function generateMsgId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function cleanupRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (now - room.lastActivity > ROOM_TTL) {
      rooms.delete(code);
      console.log(`Room ${code} expired`);
    }
  }
}
setInterval(cleanupRooms, 30000);

function json(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(data));
}

function staticFile(req, res) {
  const url = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  if (!url.startsWith('/') || url.includes('..')) { res.writeHead(403); res.end(); return; }
  const file = path.join(__dirname, '../client', url);
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, '../client/index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const types = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.ico':'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(url)] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'GET,POST', 'Access-Control-Allow-Headers':'Content-Type' });
    res.end(); return;
  }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let data = {};
      try { if (body) data = JSON.parse(body); } catch {}
      handleApi(url.pathname, req.method, data, url.searchParams, res);
    });
    return;
  }
  staticFile(req, res);
});

// ── Helper: create member record ──────────────────────────────────────
function makeMember(name, pubKey, lastSeq = 0) {
  return { name, lastSeen: Date.now(), pubKey: pubKey || null, lastSeq, lastReceiptSeq: 0 };
}

function handleApi(pathname, method, data, params, res) {

  // POST /api/create
  if (pathname === '/api/create' && method === 'POST') {
    const namedCode = data.namedCode ? data.namedCode.replace(/[^a-z0-9-]/g,'-').substring(0,40) : null;
    if (namedCode && rooms.has(namedCode)) return json(res, { error: `Room "${namedCode}" already exists.` }, 409);
    const code = namedCode || generateCode();
    const token = generateToken();
    const name = (data.name || 'Stranger').substring(0, 24);
    const deleteTimer = parseInt(data.deleteTimer) || 0;
    rooms.set(code, {
      code, createdAt: Date.now(), lastActivity: Date.now(),
      deleteTimer, msgSeq: 0, // global sequence counter
      members: new Map([[token, makeMember(name, data.pubKey)]]),
      messages: [],
      password: data.password || null,
    });
    console.log(`Room created: ${code}`);
    return json(res, { code, token, name, deleteTimer });
  }

  // POST /api/join
  if (pathname === '/api/join' && method === 'POST') {
    const code = (data.code || '').toLowerCase().trim();
    const room = rooms.get(code);
    if (!room) return json(res, { error: 'Room not found. Check the code and try again.' }, 404);
    if (room.password && room.password !== (data.password || null)) return json(res, { error: 'Incorrect password.' }, 403);
    if (room.members.size >= 2 && !data.token) return json(res, { error: 'Room is full.' }, 403);

    // Rejoin with existing token
    if (data.token && room.members.has(data.token)) {
      const member = room.members.get(data.token);
      member.lastSeen = Date.now();
      if (data.pubKey) member.pubKey = data.pubKey;
      // On rejoin — reset lastSeq to get recent messages (last 10)
      member.lastSeq = Math.max(0, room.msgSeq - 10);
      room.lastActivity = Date.now();
      let peerPubKey = null;
      for (const [t, m] of room.members.entries()) {
        if (t !== data.token) peerPubKey = m.pubKey;
      }
      return json(res, { code, token: data.token, name: member.name, isReconnect: true, peerPubKey, deleteTimer: room.deleteTimer });
    }

    const token = generateToken();
    const name = (data.name || 'Stranger').substring(0, 24);
    room.members.set(token, makeMember(name, data.pubKey, room.msgSeq));
    room.lastActivity = Date.now();

    // System message — joined
    const joinMsg = { id: generateMsgId(), seq: ++room.msgSeq, type: 'system', content: `${name} joined the room`, ts: Date.now() };
    room.messages.push(joinMsg);
    if (room.messages.length > MAX_MESSAGES) room.messages.shift(); // safe — only trims old system msgs

    let peerPubKey = null;
    for (const [t, m] of room.members.entries()) {
      if (t !== token) peerPubKey = m.pubKey;
    }
    console.log(`${name} joined room: ${code}`);
    return json(res, { code, token, name, peerPubKey, deleteTimer: room.deleteTimer });
  }

  // POST /api/send
  if (pathname === '/api/send' && method === 'POST') {
    const room = rooms.get(data.code);
    if (!room) return json(res, { error: 'Room not found' }, 404);
    if (!room.members.has(data.token)) return json(res, { error: 'Not in room' }, 403);

    const member = room.members.get(data.token);
    member.lastSeen = Date.now();
    room.lastActivity = Date.now();

    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
    const msgId = generateMsgId();
    const seq = ++room.msgSeq;

    room.messages.push({
      id: msgId, seq, type: 'message',
      from: data.token, name: member.name,
      content: data.content, time, ts: Date.now(),
      deliveredAt: null, readAt: null,
    });

    // Trim old messages — safe because we use seq not index
    if (room.messages.length > MAX_MESSAGES) room.messages.shift();

    return json(res, { ok: true, msgId, seq });
  }

  // GET /api/poll
  if (pathname === '/api/poll' && method === 'GET') {
    const code = params.get('code');
    const token = params.get('token');
    const lastSeq = parseInt(params.get('lastSeq') || '0');
    const lastReceiptSeq = parseInt(params.get('lastReceiptSeq') || '0');
    const room = rooms.get(code);
    if (!room) return json(res, { error: 'Room gone', roomGone: true });
    if (!room.members.has(token)) return json(res, { error: 'Not in room' }, 403);

    const member = room.members.get(token);
    member.lastSeen = Date.now();
    room.lastActivity = Date.now();

    // Peer status
    let peerName = null, peerOnline = false, peerPubKey = null;
    const now = Date.now();
    for (const [t, m] of room.members.entries()) {
      if (t !== token) {
        peerName = m.name;
        peerOnline = (now - m.lastSeen) < 8000;
        peerPubKey = m.pubKey;
      }
    }

    // SEQ-BASED filtering — use client's lastSeq directly
    // This is reliable even after messages.shift()
    const clientLastSeq = Math.max(lastSeq, member.lastSeq);
    const newMsgs = [];

    for (const msg of room.messages) {
      if (msg.seq <= clientLastSeq) continue;
      if (msg.from === token) continue; // skip own
      newMsgs.push(msg);
      // Mark delivered
      if (msg.type === 'message' && !msg.deliveredAt) {
        msg.deliveredAt = Date.now();
        msg.deliveredSeq = msg.seq;
      }
    }

    // Advance member's seq
    if (newMsgs.length > 0) {
      member.lastSeq = newMsgs[newMsgs.length - 1].seq;
    }

    // Read receipts for sender — use seq to avoid repeats
    const myReadReceipts = [];
    for (const msg of room.messages) {
      if (msg.from !== token) continue;
      if (msg.type !== 'message') continue;
      if (msg.deliveredAt && msg.seq > lastReceiptSeq) {
        myReadReceipts.push({
          msgId: msg.id,
          seq: msg.seq,
          deliveredAt: msg.deliveredAt,
          readAt: msg.readAt || null,
        });
      }
    }

    return json(res, {
      messages: newMsgs,
      peerName, peerOnline, peerPubKey,
      readReceipts: myReadReceipts,
      serverTime: Date.now(),
      deleteTimer: room.deleteTimer,
    });
  }

  // POST /api/read — receiver confirms message read
  if (pathname === '/api/read' && method === 'POST') {
    const room = rooms.get(data.code);
    if (!room || !room.members.has(data.token)) return json(res, { ok: true });
    if (data.msgIds && Array.isArray(data.msgIds)) {
      for (const msg of room.messages) {
        if (data.msgIds.includes(msg.id) && !msg.readAt) {
          msg.readAt = Date.now();
        }
      }
    }
    room.lastActivity = Date.now();
    return json(res, { ok: true });
  }

  // POST /api/typing
  if (pathname === '/api/typing' && method === 'POST') {
    const room = rooms.get(data.code);
    if (!room || !room.members.has(data.token)) return json(res, { ok: true });
    const member = room.members.get(data.token);
    member.lastSeen = Date.now();
    member.typing = Date.now();
    room.lastActivity = Date.now();
    return json(res, { ok: true });
  }

  // GET /api/check_typing
  if (pathname === '/api/check_typing' && method === 'GET') {
    const code = params.get('code');
    const token = params.get('token');
    const room = rooms.get(code);
    if (!room) return json(res, { typing: false });
    let peerTyping = false;
    const now = Date.now();
    for (const [t, m] of room.members.entries()) {
      if (t !== token && m.typing && (now - m.typing) < 3000) peerTyping = true;
    }
    return json(res, { typing: peerTyping });
  }

  // POST /api/leave
  if (pathname === '/api/leave' && method === 'POST') {
    const room = rooms.get(data.code);
    if (room) {
      room.members.delete(data.token);
      const seq = ++room.msgSeq;
      room.messages.push({ id: generateMsgId(), seq, type: 'system', content: `${data.name} left the room`, ts: Date.now() });
      if (room.members.size === 0) rooms.delete(data.code);
    }
    return json(res, { ok: true });
  }

  // POST /api/close
  if (pathname === '/api/close' && method === 'POST') {
    rooms.delete(data.code);
    return json(res, { ok: true });
  }

  json(res, { error: 'Not found' }, 404);
}

server.listen(PORT, () => console.log(`Vaulted running on port ${PORT}`));
