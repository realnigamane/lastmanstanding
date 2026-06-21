// Last Man Standing - multiplayer server (zero dependencies).
// Accounts + automatic matchmaking + competitive AI bots + climb-or-die gameplay.
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
const TICK_MS = 1000 / 60;           // 60 ticks/sec; physics is tuned per-tick
const BROADCAST_EVERY = 2;           // send a snapshot every 2 ticks (~30/sec)

const PW = 28, PH = 28;
const GRAVITY = 0.72, MOVE_ACCEL = 0.95, MOVE_MAX = 5.6, FRICTION = 0.80;
const JUMP_V = -15.2, MAX_FALL = 17;

// Matchmaking
const MATCH_SIZE = 8;                                       // target players per match
const MATCH_WAIT_S = Number(process.env.MATCH_WAIT_S || 10); // wait for humans, then fill with bots
const COUNTDOWN_S = 3, ROUNDOVER_S = 6;

// Climb-or-die scroll: the whole field slides DOWN and speeds up over time.
const SCROLL_START = 26;    // px/sec at the start of a round
const SCROLL_RAMP = 3.4;    // added px/sec for each second survived
const SCROLL_MAX = 150;     // hardest scroll speed
const PLAT_H = 16;
const GAP_MIN = 78, GAP_MAX = 104;   // vertical spacing between rungs (reachable by a jump)
const SPREAD = 300;                  // max horizontal shift between consecutive rungs

const COLORS = ['#ff5252', '#ffb142', '#fff35c', '#32ff7e', '#18dcff',
                '#7d5fff', '#ff4d97', '#5ad1cd', '#ff9f43', '#badc58'];
const BOT_NAMES = ['Riley', 'Max', 'Nova', 'Kai', 'Zoe', 'Leo', 'Mia', 'Finn',
                   'Ivy', 'Jax', 'Luna', 'Ace', 'Remy', 'Sky', 'Theo', 'Wren',
                   'Echo', 'Bolt', 'Pixel', 'Dash'];

// =================== Matchmaking / rooms ===================
const rooms = new Map();         // code -> room
const allSessions = new Map();   // sessionId -> human session
let nextSessionId = 1;
let formingRoom = null;          // the room currently gathering players (or null)

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function newPlayer() {
  return { x: 0, y: 0, vx: 0, vy: 0, alive: false, spectator: true,
           onPlatform: null, jumpHeld: false, color: '#fff', placedAt: 0,
           input: { left: false, right: false, jump: false } };
}
function humanCount(room) {
  let n = 0; for (const s of room.members.values()) if (!s.isBot) n++; return n;
}
function aliveList(room) {
  return [...room.members.values()].filter(s => s.player && s.player.alive && !s.player.spectator);
}

function createRoom() {
  const code = genCode();
  const room = {
    code, members: new Map(),
    phase: 'matchmaking',                 // matchmaking | countdown | playing | roundover
    fillTimer: MATCH_WAIT_S, phaseTimer: 0,
    roundTime: 0, winnerName: null, scrollSpeed: SCROLL_START,
    platforms: [], nextPlatId: 0, lastCenterX: WORLD.w / 2, tick: 0, eliminated: 0,
  };
  rooms.set(code, room);
  return room;
}

function addToMatch(s) {
  if (s.room) leaveMatch(s, true);
  if (!formingRoom || formingRoom.phase !== 'matchmaking' || humanCount(formingRoom) >= MATCH_SIZE) {
    formingRoom = createRoom();
  }
  const room = formingRoom;
  s.room = room; s.player = newPlayer();
  room.members.set(s.id, s);
  sendSearch(room);
  return room;
}
function leaveMatch(s, silent) {
  const room = s.room;
  if (!room) return;
  room.members.delete(s.id);
  s.room = null; s.player = null;
  if (formingRoom === room && humanCount(room) === 0) formingRoom = null;
  if (humanCount(room) === 0) { rooms.delete(room.code); }      // no humans -> drop match (and its bots)
  else if (room.phase === 'matchmaking') sendSearch(room);
  if (!silent) try { s.conn.send(JSON.stringify({ t: 'home' })); } catch (e) {}
}

// ---- bots ----
function uniqueBotName(room) {
  const taken = new Set([...room.members.values()].map(m => m.username.toLowerCase()));
  const pool = BOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
  let name = (pool.length ? pool[Math.floor(Math.random() * pool.length)]
                          : BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)]);
  while (taken.has(name.toLowerCase())) name = name + (Math.floor(Math.random() * 90) + 10);
  return name;
}
function makeBot(room) {
  const bot = {
    id: nextSessionId++, isBot: true, username: uniqueBotName(room),
    conn: { send() {} }, room, player: newPlayer(),
    ai: { skill: 0.8 + Math.random() * 0.2, jitter: (Math.random() - 0.5) * 10, retargetIn: 0, target: null },
  };
  room.members.set(bot.id, bot);
  return bot;
}
function fillWithBots(room) {
  while (room.members.size < MATCH_SIZE) makeBot(room);
}

// =================== Level (climb-or-die) ===================
function reachableX(room, width) {
  // Keep each new rung within a jump's horizontal reach of the previous one.
  let cx = room.lastCenterX + (Math.random() * 2 - 1) * SPREAD;
  cx = Math.max(width / 2 + 8, Math.min(WORLD.w - width / 2 - 8, cx));
  room.lastCenterX = cx;
  return cx - width / 2;
}
function makePlatform(room, y, width, moving) {
  const w = width != null ? width : 110 + Math.floor(Math.random() * 80);
  const x = reachableX(room, w);
  const drift = moving ? (0.5 + Math.random() * 1.1) * (Math.random() < 0.5 ? -1 : 1) : 0;
  return { id: room.nextPlatId++, x, y, w, h: PLAT_H, vx: drift, dx: 0 };
}
function setupRound(room) {
  room.roundTime = 0; room.winnerName = null; room.scrollSpeed = SCROLL_START;
  room.platforms = []; room.nextPlatId = 0; room.lastCenterX = WORLD.w / 2; room.eliminated = 0;

  // Wide starting platform near the bottom so everyone has a clear place to begin.
  const base = { id: room.nextPlatId++, x: WORLD.w / 2 - 200, y: WORLD.h - 96, w: 400, h: PLAT_H, vx: 0, dx: 0 };
  room.platforms.push(base);
  room.lastCenterX = WORLD.w / 2;

  // Build a stack of rungs upward (and a buffer above the screen) to climb.
  let y = base.y;
  let idx = 0;
  while (y > -160) {
    y -= GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
    const moving = idx >= 2 && Math.random() < 0.45;   // first couple rungs static, then some move
    room.platforms.push(makePlatform(room, y, null, moving));
    idx++;
  }

  // Place every player neatly along the starting platform.
  const members = [...room.members.values()];
  const n = members.length;
  members.forEach((s, i) => {
    const p = s.player;
    p.spectator = false; p.alive = true; p.vx = 0; p.vy = 0;
    p.onPlatform = base.id; p.jumpHeld = false; p.color = COLORS[i % COLORS.length];
    p.placedAt = 0;
    const slot = n > 1 ? (base.w - 60) * (i / (n - 1)) : (base.w - 60) / 2;
    p.x = base.x + 30 + slot - PW / 2;
    p.y = base.y - PH;
    if (s.isBot) { s.ai.target = null; s.ai.retargetIn = 0; }
  });
}

function topPlatformY(room) {
  let m = Infinity; for (const p of room.platforms) if (p.y < m) m = p.y;
  return m;
}

function stepPhysics(room) {
  const scrollPx = room.scrollSpeed / 60;   // per-tick downward slide

  // Move platforms: slide down + gentle horizontal drift.
  for (const p of room.platforms) {
    const oldX = p.x;
    p.y += scrollPx;
    if (p.vx) {
      p.x += p.vx;
      if (p.x <= 0) { p.x = 0; p.vx = Math.abs(p.vx); }
      if (p.x + p.w >= WORLD.w) { p.x = WORLD.w - p.w; p.vx = -Math.abs(p.vx); }
    }
    p.dx = p.x - oldX;
  }
  // Recycle platforms that slid off the bottom by adding fresh ones up top (endless climb).
  room.platforms = room.platforms.filter(p => p.y < WORLD.h + 60);
  while (topPlatformY(room) > -160) {
    const y = topPlatformY(room) - (GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN));
    room.platforms.push(makePlatform(room, y, null, Math.random() < 0.5));
  }

  for (const s of room.members.values()) {
    const p = s.player;
    if (!p || !p.alive || p.spectator) continue;

    // Carried by the platform you're standing on (down-scroll + drift).
    if (p.onPlatform != null) {
      const plat = room.platforms.find(pl => pl.id === p.onPlatform);
      if (plat) { p.x += plat.dx; p.y += scrollPx; }
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
    p.vy = Math.min(MAX_FALL, p.vy + GRAVITY);
    p.y += p.vy;
    const newBottom = p.y + PH;

    p.onPlatform = null;
    if (p.vy >= 0) {
      for (const plat of room.platforms) {
        const overlapX = p.x + PW > plat.x + 3 && p.x < plat.x + plat.w - 3;
        if (overlapX && oldBottom <= plat.y + 10 && newBottom >= plat.y) {
          p.y = plat.y - PH; p.vy = 0; p.onPlatform = plat.id; break;
        }
      }
    }

    // Death: pushed to (or fallen past) the very bottom.
    if (p.y + PH >= WORLD.h) { p.alive = false; p.spectator = true; room.eliminated++; }
  }
}

// =================== Bot AI (competitive) ===================
function botThink(room, bot) {
  const p = bot.player;
  if (!p.alive || p.spectator) { p.input.left = p.input.right = p.input.jump = false; return; }
  const feet = p.y + PH, cx = p.x + PW / 2;

  // Choose the next rung up: the lowest platform whose top is above our feet but within a jump.
  let best = null, bestScore = Infinity;
  for (const plat of room.platforms) {
    const above = plat.y < feet - 4;
    const reach = plat.y > p.y - 165;       // within jump height
    if (!above || !reach) continue;
    const platCx = plat.x + plat.w / 2;
    const dx = Math.abs(platCx - cx);
    // Prefer the closest rung up, lightly penalising big horizontal gaps.
    const score = (feet - plat.y) + dx * 0.45;
    if (score < bestScore) { bestScore = score; best = plat; }
  }
  // Fallback: nearest platform of any kind (shouldn't normally happen).
  if (!best) {
    for (const plat of room.platforms) {
      const platCx = plat.x + plat.w / 2;
      const dx = Math.abs(platCx - cx);
      if (dx < bestScore) { bestScore = dx; best = plat; }
    }
  }

  let goX = cx;
  if (best) {
    // Aim a touch ahead of a moving platform, plus a little per-bot jitter.
    goX = best.x + best.w / 2 + best.vx * 14 + bot.ai.jitter;
  }
  const dx = goX - cx;
  const dead = 6;
  p.input.left = dx < -dead;
  p.input.right = dx > dead;

  const onGround = p.onPlatform != null;
  const inDanger = feet > WORLD.h * 0.66;            // floor catching up — jump now
  const aligned = best && Math.abs(dx) < best.w / 2 + 6;
  const wantJump = onGround && ((aligned && best && best.y < feet - 6) || inDanger);
  p.input.jump = wantJump && !p.jumpHeld;
}

// =================== Match flow ===================
function startMatch(room) {
  fillWithBots(room);
  setupRound(room);
  room.phase = 'countdown'; room.phaseTimer = COUNTDOWN_S;
  if (formingRoom === room) formingRoom = null;
  broadcastRoom(room);
}
function updateRoom(room, dt) {
  if (room.phase === 'matchmaking') {
    if (humanCount(room) === 0) { rooms.delete(room.code); if (formingRoom === room) formingRoom = null; return; }
    room.fillTimer -= dt;
    if (room.members.size >= MATCH_SIZE || room.fillTimer <= 0) startMatch(room);
    return;
  }
  if (humanCount(room) === 0) { rooms.delete(room.code); if (formingRoom === room) formingRoom = null; return; }

  if (room.phase === 'countdown') {
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) { room.phase = 'playing'; room.roundTime = 0; }
  } else if (room.phase === 'playing') {
    room.roundTime += dt;
    room.scrollSpeed = Math.min(SCROLL_MAX, SCROLL_START + room.roundTime * SCROLL_RAMP);
    for (const s of room.members.values()) if (s.isBot) botThink(room, s);
    stepPhysics(room);
    const alive = aliveList(room);
    if (alive.length <= 1) {
      room.winnerName = alive.length === 1 ? alive[0].username : null;
      room.phase = 'roundover'; room.phaseTimer = ROUNDOVER_S;
      broadcastRoom(room);
    }
  } else if (room.phase === 'roundover') {
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) {
      // Send humans home; the match (and its bots) dissolves.
      for (const s of room.members.values()) {
        if (!s.isBot) { s.room = null; s.player = null; try { s.conn.send(JSON.stringify({ t: 'home' })); } catch (e) {} }
      }
      rooms.delete(room.code);
      if (formingRoom === room) formingRoom = null;
    }
  }
}

// =================== Snapshots ===================
function memberList(room) {
  return [...room.members.values()].map(s => ({
    name: s.username,
    color: s.player ? s.player.color : '#fff',
    alive: !!(s.player && s.player.alive),
  }));
}
function sendSearch(room) {
  const msg = JSON.stringify({
    t: 'searching',
    found: humanCount(room),
    target: MATCH_SIZE, secs: Math.max(0, Math.ceil(room.fillTimer)),
    members: memberList(room),
  });
  for (const s of room.members.values()) if (!s.isBot) { try { s.conn.send(msg); } catch (e) {} }
}
function roomSnapshot(room) {
  const snap = {
    t: 'snapshot', code: room.code, phase: room.phase,
    countdown: Math.max(0, Math.ceil(room.phaseTimer)),
    roundTime: Math.floor(room.roundTime), winner: room.winnerName,
    alive: aliveList(room).length, total: room.members.size,
    scroll: Math.round(room.scrollSpeed),
    platforms: room.platforms.map(p => ({ x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h })),
    players: [...room.members.values()].map(s => ({
      id: s.username, name: s.username, color: s.player.color,
      x: Math.round(s.player.x), y: Math.round(s.player.y),
      alive: s.player.alive, spectator: s.player.spectator, vx: Math.round(s.player.vx),
    })),
  };
  return JSON.stringify(snap);
}
function broadcastRoom(room) {
  if (room.phase === 'matchmaking') { sendSearch(room); return; }
  const msg = roomSnapshot(room);
  for (const s of room.members.values()) if (!s.isBot) { try { s.conn.send(msg); } catch (e) {} }
}

// =================== Game loop ===================
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  for (const room of [...rooms.values()]) {
    updateRoom(room, dt);
    if (!rooms.has(room.code)) continue;     // dissolved this tick
    room.tick++;
    if (room.phase === 'matchmaking') {
      if (room.tick % 30 === 0) sendSearch(room);   // ~2x/sec so the countdown ticks live
    } else if (room.tick % BROADCAST_EVERY === 0) {
      broadcastRoom(room);
    }
  }
}, TICK_MS);

// =================== Connections ===================
ws.attach(server, (conn) => {
  const s = { id: nextSessionId++, conn, username: null, key: null, room: null, player: null, isBot: false };
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
      }).catch((e) => {
        console.error('auth lookup failed:', e.message);
        conn.send(JSON.stringify({ t: 'authfail' }));
      });
      return;
    }
    if (!s.username) return; // everything below requires auth

    if (m.t === 'findMatch') {
      addToMatch(s);
    } else if (m.t === 'leaveMatch') {
      leaveMatch(s, false);
    } else if (m.t === 'input') {
      if (s.room && s.player && s.room.phase === 'playing') {
        s.player.input.left = !!m.left;
        s.player.input.right = !!m.right;
        s.player.input.jump = !!m.jump;
      }
    }
  });

  conn.on('close', () => {
    leaveMatch(s, true);
    allSessions.delete(s.id);
  });
});

server.listen(PORT, () => {
  console.log('Last Man Standing running at  http://localhost:' + PORT);
  console.log('Accounts storage: ' + (store.backend === 'supabase' ? 'Supabase (Postgres)' : 'local file (data/users.json)'));
  console.log('Sign in, hit Find Match — bots fill any empty slots so a game always starts.');
});

// Exported for the automated tests.
module.exports = { server };
