const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ROOM_TTL = 5 * 60 * 1000; // 5 minutes inactive = room closes
const MAX_MESSAGES = 200;

// In-memory rooms — no persistence
const rooms = new Map();
/*
room = {
  code, createdAt, lastActivity,
  members: Map<token, { name, lastSeen, pubKey }>,
  messages: [{ id, from, name, content, time, ts }],
  pubKeys: Map<token, pubKeyB64>
}
*/

function generateCode() {
  const w = ['amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember','fern','flame','frost','ghost','glass','gold','grove','haven','iron','jade','karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova','oak','opal','orbit','pearl','pine','prism','rain','raven','reed','ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silk','silver','slate','smoke','snow','spark','star','steel','storm','tide','timber','topaz','vale','vault','veil','wave','wild','wind','wolf'];
  const p = () => w[Math.floor(Math.random() * w.length)];
  return `${p()}-${p()}-${Math.floor(Math.random() * 90 + 10)}`;
}

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
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
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
    const ext = path.extname(url);
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // ── API routes ────────────────────────────────────────────────────
  if (pathname.startsWith('/api/')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      let data = {};
      try { if (body) data = JSON.parse(body); } catch {}
      handleApi(pathname, req.method, data, url.searchParams, res);
    });
    return;
  }

  staticFile(req, res);
});

function handleApi(path, method, data, params, res) {
  // POST /api/create — create a new room
  if (path === '/api/create' && method === 'POST') {
    // Use namedCode if provided, otherwise generate random code
    let code = data.namedCode
      ? data.namedCode.toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 40)
      : generateCode();
    if (rooms.has(code)) {
      return json(res, { error: `Room "${code}" already exists. Join it or pick another name.` }, 409);
    }
    const token = generateToken();
    const name = (data.name || 'Stranger').substring(0, 24);
    const password = data.password || null;
    rooms.set(code, {
      code, createdAt: Date.now(), lastActivity: Date.now(),
      password,
      members: new Map([[token, { name, lastSeen: Date.now(), pubKey: data.pubKey || null }]]),
      messages: [],
      pubKeys: new Map([[token, data.pubKey || null]])
    });
    console.log(`Room created: ${code}`);
    return json(res, { code, token, name });
  }

  // POST /api/join — join existing room
  if (path === '/api/join' && method === 'POST') {
    const code = (data.code || '').toLowerCase().trim();
    const room = rooms.get(code);
    if (!room) return json(res, { error: 'Room not found. Check the code and try again.' }, 404);
    if (room.password && room.password !== (data.password || '')) {
      return json(res, { error: 'Incorrect password.' }, 403);
    }
    if (room.members.size >= 2 && !data.token) return json(res, { error: 'Room is full.' }, 403);

    // Rejoin with existing token
    if (data.token && room.members.has(data.token)) {
      const member = room.members.get(data.token);
      member.lastSeen = Date.now();
      if (data.pubKey) member.pubKey = data.pubKey;
      room.lastActivity = Date.now();
      // Get peer's pubKey
      let peerPubKey = null;
      for (const [t, m] of room.members.entries()) {
        if (t !== data.token) peerPubKey = m.pubKey;
      }
      return json(res, { code, token: data.token, name: member.name, isReconnect: true, peerPubKey });
    }

    const token = generateToken();
    const name = (data.name || 'Stranger').substring(0, 24);
    room.members.set(token, { name, lastSeen: Date.now(), pubKey: data.pubKey || null });
    room.lastActivity = Date.now();

    // Notify via messages that peer joined
    room.messages.push({
      id: Date.now(), type: 'system', content: `${name} joined the room`, ts: Date.now()
    });

    // Get creator's pubKey
    let peerPubKey = null;
    for (const [t, m] of room.members.entries()) {
      if (t !== token) peerPubKey = m.pubKey;
    }

    console.log(`${name} joined room: ${code}`);
    return json(res, { code, token, name, peerPubKey });
  }

  // POST /api/send — send a message
  if (path === '/api/send' && method === 'POST') {
    const room = rooms.get(data.code);
    if (!room) return json(res, { error: 'Room not found' }, 404);
    if (!room.members.has(data.token)) return json(res, { error: 'Not in room' }, 403);

    const member = room.members.get(data.token);
    member.lastSeen = Date.now();
    room.lastActivity = Date.now();

    const now = new Date();
    const time = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');

    room.messages.push({
      id: Date.now() + Math.random(),
      type: 'message',
      from: data.token,
      name: member.name,
      content: data.content,
      time,
      ts: Date.now()
    });

    // Keep only last 200 messages
    if (room.messages.length > MAX_MESSAGES) room.messages.shift();

    return json(res, { ok: true });
  }

  // GET /api/poll — get new messages since lastId
  if (path === '/api/poll' && method === 'GET') {
    const code = params.get('code');
    const token = params.get('token');
    const since = parseFloat(params.get('since') || '0');

    const room = rooms.get(code);
    if (!room) return json(res, { error: 'Room gone', roomGone: true });
    if (!room.members.has(token)) return json(res, { error: 'Not in room' }, 403);

    // Update lastSeen
    const member = room.members.get(token);
    member.lastSeen = Date.now();
    room.lastActivity = Date.now();

    // Get peer status
    let peerName = null, peerOnline = false, peerPubKey = null;
    const now = Date.now();
    for (const [t, m] of room.members.entries()) {
      if (t !== token) {
        peerName = m.name;
        peerOnline = (now - m.lastSeen) < 8000; // online if polled in last 8s
        peerPubKey = m.pubKey;
      }
    }

    // Messages since last poll
    const newMsgs = room.messages.filter(m => m.ts > since && m.from !== token);

    return json(res, {
      messages: newMsgs,
      peerName,
      peerOnline,
      peerPubKey,
      serverTime: Date.now()
    });
  }

  // POST /api/typing — notify typing
  if (path === '/api/typing' && method === 'POST') {
    const room = rooms.get(data.code);
    if (!room || !room.members.has(data.token)) return json(res, { ok: true });
    const member = room.members.get(data.token);
    member.lastSeen = Date.now();
    member.typing = Date.now();
    room.lastActivity = Date.now();
    return json(res, { ok: true });
  }

  // GET /api/typing — check if peer is typing
  if (path === '/api/check_typing' && method === 'GET') {
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

  // POST /api/leave — leave room
  if (path === '/api/leave' && method === 'POST') {
    const room = rooms.get(data.code);
    if (room) {
      room.members.delete(data.token);
      room.messages.push({ id: Date.now(), type: 'system', content: `${data.name} left the room`, ts: Date.now() });
      if (room.members.size === 0) rooms.delete(data.code);
    }
    return json(res, { ok: true });
  }

  // POST /api/close — close room entirely
  if (path === '/api/close' && method === 'POST') {
    rooms.delete(data.code);
    return json(res, { ok: true });
  }

  json(res, { error: 'Not found' }, 404);
}

server.listen(PORT, () => console.log(`Vaulted (HTTP polling) running on port ${PORT}`));
