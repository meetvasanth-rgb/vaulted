const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const HEARTBEAT_INTERVAL = 30000;  // 30 seconds
const HEARTBEAT_TIMEOUT  = 65000;  // 65 seconds — miss 2 beats = dead

const rooms = new Map();

function generateCode() {
  const words = [
    'amber','arctic','azure','cedar','cloud','coral','dawn','delta','dusk','ember',
    'fern','flame','frost','ghost','glass','gold','grove','haven','iron','jade',
    'karma','lake','lemon','lime','lunar','maple','mist','moon','moss','nova',
    'oak','opal','orbit','pearl','pine','prism','quartz','rain','raven','reed',
    'ridge','river','rose','ruby','sage','salt','sand','shadow','shore','silk',
    'silver','slate','smoke','snow','solar','sonic','spark','star','steel','storm',
    'tide','timber','topaz','vale','vault','veil','wave','wild','wind','wolf',
    'amber','birch','blaze','bloom','bolt','bone','brew','brick','brine','brook',
  ];
  const pick = () => words[Math.floor(Math.random() * words.length)];
  return `${pick()}-${pick()}-${Math.floor(Math.random() * 90 + 10)}`;
}

function cleanRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.timer) clearTimeout(room.timer);
  room.clients.forEach(({ ws }) => { try { ws.close(); } catch {} });
  rooms.delete(code);
  console.log(`Room ${code} closed`);
}

function broadcast(room, data, excludeWs = null) {
  const msg = JSON.stringify(data);
  room.clients.forEach(({ ws }) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

function broadcastAll(room, data) { broadcast(room, data, null); }

// ── Heartbeat checker — runs every 30s ───────────────────────────────
function startHeartbeatChecker() {
  setInterval(() => {
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
      const timedOut = [];
      for (const client of room.clients) {
        if (now - client.lastSeen > HEARTBEAT_TIMEOUT) {
          timedOut.push(client);
        }
      }
      for (const client of timedOut) {
        console.log(`Client ${client.name} timed out in room ${code}`);
        room.clients.delete(client);
        try { client.ws.close(); } catch {}
        // Notify remaining peer
        broadcast(room, { type: 'peer_timeout', name: client.name });
        if (room.clients.size === 0) cleanRoom(code);
      }
    }
  }, HEARTBEAT_INTERVAL);
}

// Serve static files
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  if (!url.startsWith('/') || url.includes('..')) { res.writeHead(403); res.end(); return; }
  const file = path.join(__dirname, '../client', url);
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, '../client/index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d2);
      });
      return;
    }
    const ext = path.extname(url);
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ico': 'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });
startHeartbeatChecker();

wss.on('connection', (ws) => {
  let currentRoom = null;
  let clientRecord = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // Update lastSeen on every message (including ping)
    if (clientRecord) clientRecord.lastSeen = Date.now();

    // ── PING / PONG ────────────────────────────────────────────────
    if (msg.type === 'ping') {
      ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }

    // ── CREATE ROOM ────────────────────────────────────────────────
    if (msg.type === 'create') {
      const code = generateCode();
      const name = (msg.name || 'Stranger').substring(0, 24);
      const pubKey = msg.pubKey || null;
      rooms.set(code, {
        clients: new Set(),
        createdAt: Date.now(),
        timer: setTimeout(() => cleanRoom(code), 24 * 60 * 60 * 1000),
      });
      const room = rooms.get(code);
      clientRecord = { ws, name, pubKey, lastSeen: Date.now() };
      room.clients.add(clientRecord);
      currentRoom = code;
      ws.send(JSON.stringify({ type: 'created', code, name }));
      console.log(`Room created: ${code}`);
      return;
    }

    // ── CREATE NAMED ROOM ──────────────────────────────────────────
    if (msg.type === 'create_named') {
      const roomName = (msg.roomName || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').substring(0, 40);
      const name = (msg.name || 'Stranger').substring(0, 24);
      const password = msg.password || null;
      const pubKey = msg.pubKey || null;
      if (!roomName) { ws.send(JSON.stringify({ type: 'error', message: 'Invalid room name.' })); return; }
      if (rooms.has(roomName)) { ws.send(JSON.stringify({ type: 'error', message: `Room "${roomName}" already exists. Join it instead.` })); return; }
      rooms.set(roomName, {
        clients: new Set(),
        createdAt: Date.now(),
        password,
        isNamed: true,
        timer: setTimeout(() => cleanRoom(roomName), 7 * 24 * 60 * 60 * 1000),
      });
      const room = rooms.get(roomName);
      clientRecord = { ws, name, pubKey, lastSeen: Date.now() };
      room.clients.add(clientRecord);
      currentRoom = roomName;
      ws.send(JSON.stringify({ type: 'named_created', roomName, name }));
      console.log(`Named room created: ${roomName}`);
      return;
    }

    // ── JOIN ROOM ──────────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = (msg.code || '').toLowerCase().trim();
      const name = (msg.name || 'Stranger').substring(0, 24);
      const password = msg.password || null;
      const pubKey = msg.pubKey || null;
      const room = rooms.get(code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code and try again.' })); return; }
      if (room.password && room.password !== password) { ws.send(JSON.stringify({ type: 'error', message: 'Incorrect password.' })); return; }
      if (room.clients.size >= 2) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full — only two people allowed.' })); return; }

      clientRecord = { ws, name, pubKey, lastSeen: Date.now() };
      room.clients.add(clientRecord);
      currentRoom = code;
      ws.send(JSON.stringify({ type: 'joined', code, name }));

      // Exchange public keys
      if (pubKey) broadcast(room, { type: 'peer_pubkey', pubKey }, ws);
      room.clients.forEach(({ ws: cws, pubKey: cPubKey }) => {
        if (cws !== ws && cPubKey) ws.send(JSON.stringify({ type: 'peer_pubkey', pubKey: cPubKey }));
      });

      broadcast(room, { type: 'peer_joined', name }, ws);
      console.log(`${name} joined room: ${code}`);
      return;
    }

    // ── MESSAGE ────────────────────────────────────────────────────
    if (msg.type === 'message' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (!room) return;
      const content = (msg.content || '').substring(0, 2000);
      if (!content.trim()) return;
      const now = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
      broadcast(room, { type: 'message', content, name: clientRecord?.name ?? 'Stranger', time: now }, ws);
      return;
    }

    // ── TYPING ─────────────────────────────────────────────────────
    if (msg.type === 'typing' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (!room) return;
      broadcast(room, { type: 'typing', name: clientRecord?.name ?? 'Stranger' }, ws);
      return;
    }

    // ── LEAVE ROOM (stay in server, just disconnect) ───────────────
    if (msg.type === 'leave_room' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (room && clientRecord) {
        room.clients.delete(clientRecord);
        broadcast(room, { type: 'peer_left', name: clientRecord.name });
      }
      currentRoom = null;
      return;
    }

    // ── CLOSE ROOM ─────────────────────────────────────────────────
    if (msg.type === 'close_room' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        broadcastAll(room, { type: 'room_closed', message: 'Room was closed.' });
        cleanRoom(currentRoom);
        currentRoom = null;
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;
    if (clientRecord) room.clients.delete(clientRecord);
    if (room.clients.size === 0) {
      cleanRoom(currentRoom);
    } else {
      broadcast(room, { type: 'peer_left', name: clientRecord?.name ?? 'Stranger' });
    }
    currentRoom = null;
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Vaulted running on port ${PORT}`);
});
