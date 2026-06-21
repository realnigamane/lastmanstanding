// Last Man Standing - multiplayer server with accounts + lobby/rooms (zero dependencies).
// Run:  node server.js   then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Load .env (so SUPABASE_* etc. are available before requiring the store) ----
(function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !m[1].startsWith('#')) {
        const k = m[1];
        let v = m[2].trim().replace(/^["']|["']$/g, '');
        if (!(k in process.env)) process.env[k] = v;
      }
    }
  } catch (e) { /* ignore malformed .env */ }
})();

const ws = require('./ws');
const store = require('./store');

const PORT = process.env.PORT || 3000;

// =================== Accounts ===================
const sessionsByToken = new Map(); // token -> user key

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const makeToken = () => crypto.randomBytes(24).toString('hex');

async function registerUser(username, password) {
  username = String(username || '').trim();
  if (username.length < 3 || username.length > 16) return { error: 'Username must be 3-16 characters.' };
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return { error: 'Use letters, numbers, and underscores only.' };
  if (String(password || '').length < 4) return { error: 'Password must be at least 4 characters.' };
  const key = username.toLowerCase();
  if (await store.getUser(key)) return { error: 'That username is already taken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { username, username_lower: key, salt, hash: hashPw(password, salt),
                 credits: 1000, created_at: new Date().toISOString() };
  try { await store.createUser(user); }
  catch (e) { if (e.message === 'DUPLICATE') return { error: 'That username is already taken.' }; throw e; }
  const token = makeToken(); sessionsByToken.set(token, key);
  return { ok: true, token, username, credits: 1000 };
}
async function loginUser(username, password) {
  const key = String(username || '').trim().toLowerCase();
  const u = await store.getUser(key);
  if (!u) return { error: 'No account with that username.' };
  let ok = false;
  try {
    ok = crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
  } catch (e) { ok = false; }
  if (!ok) return { error: 'Incorrect password.' };
  const token = makeToken(); sessionsByToken.set(token, key);
  return { ok: true, token, username: u.username, credits: u.credits };
}

// =================== HTTP (static + auth API) ===================
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      let data = {}; try { data = JSON.parse(body || '{}'); } catch (e) {}
      try {
        let result;
        if (req.url === '/api/register') result = await registerUser(data.username, data.password);
        else if (req.url === '/api/login') result = await loginUser(data.username, data.password);
        else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
        res.writeHead(result.error ? 400 : 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        console.error('API error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Server/database error. Check the server console.' }));
      }
    });
    return;
  }
  // Static files: serve ONLY these from the project root. An explicit allowlist
  // means server code, .env, and other files can never be fetched over the web.
  const STATIC = new Set(['index.html', 'client.js']);
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  const file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (!STATIC.has(file)) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// =================== Game constants ===================
const WORLD = { w: 960, h: 600 };
const TICK_MS = 1000 / 60;
const BROADCAST_EVERY = 2;
const PW = 30, PH = 30;
const GRAVITY_BASE = 0.75, MOVE_ACCEL = 0.9, MOVE_MAX = 5.2, FRICTION = 0.78;
const JUMP_V = -15, MAX_FALL = 16;
const COUNTDOWN_S = 4, ROUNDOVER_S = 6;
const MIN_TO_START = 2, MIN_PLATFORMS = 2;
const COLORS = ['#ff5252', '#ffb142', '#fffa65', '#32ff7e', '#18dcff',
                '#7d5fff', '#ff4d97', '#cd6133', '#ffffff', '#badc58'];

// =================== Rooms ===================
const rooms = new Map();         // code -> room
const allSessions = new Map();   // sessionId -> session
let nextSessionId = 1;

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function createRoom(hostSession, maxPlayers) {
  const code = genCode();
  const room = {
    code, hostId: hostSession.id,
    maxPlayers: Math.min(10, Math.max(2, maxPlayers || 8)),
    members: new Map(),        // sessionId -> session
    phase: 'waiting',          // waiting | countdown | playing | roundover
    phaseTimer: 0, roundTime: 0, winnerName: null,
    platforms: [], nextPlatRemoval: 0, tick: 0,
  };
  rooms.set(code, room);
  return room;
}
function newPlayer() {
  return { x: 0, y: 0, vx: 0, vy: 0, alive: false, spectator: true,
           onPlatform: null, jumpHeld: false, color: '#fff',
           input: { left: false, right: false, jump: false } };
}
function hostName(room) {
  const h = room.members.get(room.hostId);
  return h ? h.username : '—';
}

function joinRoom(s, room) {
  if (room.members.size >= room.maxPlayers) return { error: 'That room is full.' };
  s.room = room; s.ready = false; s.player = newPlayer();
  // joining mid-game: wait as spectator until next round
  if (room.phase !== 'waiting') { s.player.spectator = true; s.player.alive = false; }
  room.members.set(s.id, s);
  pushLobby();
  return { ok: true };
}
function leaveRoom(s) {
  const room = s.room;
  if (!room) return;
  room.members.delete(s.id);
  s.room = null; s.player = null; s.ready = false;
  if (room.members.size === 0) {
    rooms.delete(room.code);
  } else if (room.hostId === s.id) {
    room.hostId = room.members.keys().next().value; // promote next member
  }
  pushLobby();
}

function setupRound(room) {
  room.roundTime = 0; room.nextPlatRemoval = 8; room.winnerName = null;
  const defs = [
    { x: 120, y: 470, w: 200 }, { x: 620, y: 470, w: 200 },
    { x: 380, y: 360, w: 200 }, { x: 90, y: 250, w: 170 },
    { x: 700, y: 250, w: 170 }, { x: 400, y: 150, w: 160 },
    { x: 250, y: 540, w: 460 },
  ];
  room.platforms = defs.map((d, i) => ({
    id: i, x: d.x, y: d.y, w: d.w, h: 18,
    baseSpeed: 0.6 + Math.random() * 0.8, dir: Math.random() < 0.5 ? -1 : 1, dx: 0,
  }));
  let i = 0;
  for (const s of room.members.values()) {
    const p = s.player;
    p.spectator = false; p.alive = true; p.vx = 0; p.vy = 0;
    p.onPlatform = null; p.jumpHeld = false; p.color = COLORS[i % COLORS.length];
    const plat = room.platforms[i % room.platforms.length];
    p.x = plat.x + plat.w / 2 - PW / 2;
    p.y = plat.y - PH - 1;
    i++;
  }
}
function startGame(room) {
  if (room.phase !== 'waiting' || room.members.size < MIN_TO_START) return;
  setupRound(room);
  room.phase = 'countdown'; room.phaseTimer = COUNTDOWN_S;
  pushLobby();
}
function aliveList(room) {
  return [...room.members.values()].filter(s => s.player && s.player.alive && !s.player.spectator);
}
function difficulty(room) {
  return { speedMult: 1 + room.roundTime * 0.06, gravity: GRAVITY_BASE + room.roundTime * 0.004 };
}
function stepPhysics(room) {
  const { speedMult, gravity } = difficulty(room);
  for (const p of room.platforms) {
    const oldX = p.x;
    p.x += p.baseSpeed * p.dir * speedMult;
    if (p.x <= 0) { p.x = 0; p.dir = 1; }
    if (p.x + p.w >= WORLD.w) { p.x = WORLD.w - p.w; p.dir = -1; }
    p.dx = p.x - oldX;
  }
  for (const s of room.members.values()) {
    const p = s.player;
    if (!p || !p.alive || p.spectator) continue;
    if (p.onPlatform != null) {
      const plat = room.platforms.find(pl => pl.id === p.onPlatform);
      if (plat) p.x += plat.dx;
    }
    if (p.input.left) p.vx -= MOVE_ACCEL;
    if (p.input.right) p.vx += MOVE_ACCEL;
    if (!p.input.left && !p.input.right) p.vx *= FRICTION;
    p.vx = Math.max(-MOVE_MAX, Math.min(MOVE_MAX, p.vx));
    const onGround = p.onPlatform != null;
    if (p.input.jump && !p.jumpHeld && onGround) p.vy = JUMP_V;
    p.jumpHeld = p.input.jump;
    p.x += p.vx;
    p.x = Math.max(0, Math.min(WORLD.w - PW, p.x));
    const oldBottom = p.y + PH;
    p.vy = Math.min(MAX_FALL, p.vy + gravity);
    p.y += p.vy;
    const newBottom = p.y + PH;
    p.onPlatform = null;
    if (p.vy >= 0) {
      for (const plat of room.platforms) {
        const overlapX = p.x + PW > plat.x + 3 && p.x < plat.x + plat.w - 3;
        if (overlapX && oldBottom <= plat.y + 8 && newBottom >= plat.y) {
          p.y = plat.y - PH; p.vy = 0; p.onPlatform = plat.id; break;
        }
      }
    }
    if (p.y > WORLD.h + 40) { p.alive = false; p.spectator = true; }
  }
}
function updateRoom(room, dt) {
  if (room.phase === 'waiting') {
    if (room.members.size >= room.maxPlayers) startGame(room); // auto-start when full
  } else if (room.phase === 'countdown') {
    if (room.members.size < MIN_TO_START) { room.phase = 'waiting'; pushLobby(); return; }
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) { room.phase = 'playing'; room.roundTime = 0; }
  } else if (room.phase === 'playing') {
    room.roundTime += dt;
    stepPhysics(room);
    if (room.roundTime >= room.nextPlatRemoval && room.platforms.length > MIN_PLATFORMS) {
      room.platforms.sort((a, b) => b.y - a.y);
      room.platforms.shift();
      room.nextPlatRemoval += 8;
    }
    const alive = aliveList(room);
    if (alive.length <= 1) {
      room.winnerName = alive.length === 1 ? alive[0].username : null;
      room.phase = 'roundover'; room.phaseTimer = ROUNDOVER_S;
      pushLobby();
    }
  } else if (room.phase === 'roundover') {
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) {
      for (const s of room.members.values()) { if (s.player) { s.player.alive = false; s.player.spectator = true; } }
      room.phase = 'waiting';
      pushLobby();
    }
  }
}

function roomSnapshot(room) {
  const snap = {
    t: 'snapshot',
    code: room.code, host: hostName(room), maxPlayers: room.maxPlayers,
    phase: room.phase, countdown: Math.max(0, Math.ceil(room.phaseTimer)),
    roundTime: Math.floor(room.roundTime), winner: room.winnerName,
    alive: aliveList(room).length, minToStart: MIN_TO_START,
    members: [...room.members.values()].map(s => ({
      username: s.username, color: s.player ? s.player.color : '#fff',
      ready: !!s.ready, alive: !!(s.player && s.player.alive),
      isHost: s.id === room.hostId,
    })),
  };
  if (room.phase !== 'waiting') {
    snap.platforms = room.platforms.map(p => ({ x: Math.round(p.x), y: p.y, w: p.w, h: p.h }));
    snap.players = [...room.members.values()].map(s => ({
      id: s.username, name: s.username, color: s.player.color,
      x: Math.round(s.player.x), y: Math.round(s.player.y),
      alive: s.player.alive, spectator: s.player.spectator, vx: Math.round(s.player.vx),
    }));
  }
  return JSON.stringify(snap);
}
function broadcastRoom(room) {
  const msg = roomSnapshot(room);
  for (const s of room.members.values()) s.conn.send(msg);
}
function publicRoomList() {
  return [...rooms.values()].map(r => ({
    code: r.code, host: hostName(r), players: r.members.size, max: r.maxPlayers, phase: r.phase,
  }));
}
function pushLobby() {
  const msg = JSON.stringify({ t: 'rooms', list: publicRoomList() });
  for (const s of allSessions.values()) if (s.username && !s.room) s.conn.send(msg);
}

// =================== Game loop ===================
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = (now - last) / 1000;
  last = now;
  for (const room of rooms.values()) {
    if (room.members.size === 0) { rooms.delete(room.code); continue; }
    updateRoom(room, dt);
    room.tick++;
    if (room.tick % BROADCAST_EVERY === 0) broadcastRoom(room);
  }
}, TICK_MS);

// =================== Connections ===================
ws.attach(server, (conn) => {
  const s = { id: nextSessionId++, conn, username: null, key: null, room: null, player: null, ready: false };
  allSessions.set(s.id, s);

  conn.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'auth') {
      const key = sessionsByToken.get(m.token);
      if (!key) { conn.send(JSON.stringify({ t: 'authfail' })); return; }
      store.getUser(key).then((u) => {
        if (!u) { conn.send(JSON.stringify({ t: 'authfail' })); return; }
        s.username = u.username; s.key = key;
        conn.send(JSON.stringify({ t: 'authed', username: u.username, credits: u.credits }));
        pushLobby();
        conn.send(JSON.stringify({ t: 'rooms', list: publicRoomList() }));
      }).catch((e) => {
        console.error('auth lookup failed:', e.message);
        conn.send(JSON.stringify({ t: 'authfail' }));
      });
      return;
    }
    if (!s.username) return; // everything below requires auth

    if (m.t === 'createRoom') {
      if (s.room) leaveRoom(s);
      const room = createRoom(s, m.maxPlayers);
      joinRoom(s, room);
    } else if (m.t === 'joinRoom') {
      const room = rooms.get(String(m.code || '').toUpperCase());
      if (!room) { conn.send(JSON.stringify({ t: 'error', msg: 'No room with that code.' })); return; }
      if (s.room) leaveRoom(s);
      const r = joinRoom(s, room);
      if (r.error) conn.send(JSON.stringify({ t: 'error', msg: r.error }));
    } else if (m.t === 'quickPlay') {
      if (s.room) leaveRoom(s);
      let room = [...rooms.values()].find(r => r.phase === 'waiting' && r.members.size < r.maxPlayers);
      if (!room) room = createRoom(s, 8);
      joinRoom(s, room);
    } else if (m.t === 'leaveRoom') {
      leaveRoom(s);
      conn.send(JSON.stringify({ t: 'left' }));
    } else if (m.t === 'ready') {
      s.ready = !!m.value;
    } else if (m.t === 'startGame') {
      if (s.room && s.id === s.room.hostId) startGame(s.room);
    } else if (m.t === 'input') {
      if (s.room && s.player && s.room.phase === 'playing') {
        s.player.input.left = !!m.left;
        s.player.input.right = !!m.right;
        s.player.input.jump = !!m.jump;
      }
    }
  });

  conn.on('close', () => {
    leaveRoom(s);
    allSessions.delete(s.id);
  });
});

server.listen(PORT, () => {
  console.log('Last Man Standing running at  http://localhost:' + PORT);
  console.log('Accounts storage: ' + (store.backend === 'supabase' ? 'Supabase (Postgres)' : 'local file (data/users.json)'));
  console.log('Create an account, make a room, share the 4-letter code (or open more tabs) to play.');
});
