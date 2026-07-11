const { WebSocketServer, WebSocket } = require('ws');
const http = require('http');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;

// In-memory rooms only — nothing ever touches disk
const rooms = new Map();
// rooms = { code: { clients: Set<{ws, name}>, createdAt, timer } }

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
  room.clients.forEach(({ ws }) => {
    try { ws.close(); } catch {}
  });
  rooms.delete(code);
  console.log(`Room ${code} closed — no trace`);
}

function broadcast(room, data, excludeWs = null) {
  const msg = JSON.stringify(data);
  room.clients.forEach(({ ws }) => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

function broadcastAll(room, data) {
  broadcast(room, data, null);
}

// HTTP server — serves the single HTML file
const server = http.createServer((req, res) => {
  const url = req.url === '/' ? '/index.html' : req.url;
  const file = path.join(__dirname, '../client', url);

  // Only serve static files
  if (!url.startsWith('/') || url.includes('..')) {
    res.writeHead(403); res.end(); return;
  }

  fs.readFile(file, (err, data) => {
    if (err) {
      // For SPA routing — always return index.html
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

// WebSocket server
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let clientRecord = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── CREATE ROOM ──────────────────────────────────────────
    if (msg.type === 'create') {
      const code = generateCode();
      const name = (msg.name || 'Stranger').substring(0, 24);
      const pubKey = msg.pubKey || null;
      rooms.set(code, {
        clients: new Set(),
        createdAt: Date.now(),
        timer: setTimeout(() => cleanRoom(code), 24 * 60 * 60 * 1000), // 24h auto-close
      });
      const room = rooms.get(code);
      clientRecord = { ws, name, pubKey };
      room.clients.add(clientRecord);
      currentRoom = code;

      ws.send(JSON.stringify({ type: 'created', code, name }));
      console.log(`Room created: ${code}`);
      return;
    }

    // ── JOIN ROOM ────────────────────────────────────────────
    if (msg.type === 'join') {
      const code = (msg.code || '').toLowerCase().trim();
      const name = (msg.name || 'Stranger').substring(0, 24);
      const room = rooms.get(code);

      if (!room) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room not found. Check the code and try again.' }));
        return;
      }
      if (room.clients.size >= 2) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full — only two people allowed.' }));
        return;
      }

      const pubKey = msg.pubKey || null;
      clientRecord = { ws, name, pubKey };
      room.clients.add(clientRecord);
      currentRoom = code;

      ws.send(JSON.stringify({ type: 'joined', code, name }));

      // Exchange public keys for E2E encryption
      if (pubKey) {
        // Send joiner's pubkey to creator
        broadcast(room, { type: 'peer_pubkey', pubKey }, ws);
      }
      // Send creator's pubkey to joiner
      room.clients.forEach(({ ws: cws, pubKey: cPubKey }) => {
        if (cws !== ws && cPubKey) {
          ws.send(JSON.stringify({ type: 'peer_pubkey', pubKey: cPubKey }));
        }
      });

      // Notify the other person
      broadcast(room, { type: 'peer_joined', name }, ws);
      console.log(`${name} joined room: ${code}`);
      return;
    }

    // ── MESSAGE ──────────────────────────────────────────────
    if (msg.type === 'message' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (!room) return;
      const content = (msg.content || '').substring(0, 2000);
      if (!content.trim()) return;

      // Relay to other person — never stored
      broadcast(room, {
        type: 'message',
        content,
        name: clientRecord?.name ?? 'Stranger',
        time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      }, ws);
      return;
    }

    // ── TYPING ───────────────────────────────────────────────
    if (msg.type === 'typing' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (!room) return;
      broadcast(room, { type: 'typing', name: clientRecord?.name ?? 'Stranger' }, ws);
      return;
    }

    // ── CLOSE ROOM ───────────────────────────────────────────
    if (msg.type === 'close_room' && currentRoom) {
      const room = rooms.get(currentRoom);
      if (room) {
        broadcastAll(room, { type: 'room_closed', message: 'Room closed by the other person.' });
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
      // Last person left — wipe room
      cleanRoom(currentRoom);
    } else {
      // Notify other person
      broadcast(room, { type: 'peer_left', name: clientRecord?.name ?? 'Stranger' });
    }
    currentRoom = null;
  });

  ws.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`Vaulted running on port ${PORT}`);
});
