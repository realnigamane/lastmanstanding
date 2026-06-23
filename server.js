// Last Duck Standing - multiplayer server (zero dependencies).
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

// The admin account. This username is reserved (cannot be registered publicly)
// and unlocks the /admin portal. Auth still goes through the normal login flow,
// so the password is only ever stored as a salted hash in the database.
const ADMIN_USER = 'deedotheadmin';

// Rank tiers — a player's rank goes up every 5 wins.
const RANKS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Grandmaster', 'Legend', 'Mythic', 'Duck God'];
function rankFor(wins) {
  const i = Math.min(RANKS.length - 1, Math.floor((wins || 0) / 5));
  return { tier: RANKS[i], level: i + 1, toNext: i < RANKS.length - 1 ? (i + 1) * 5 - (wins || 0) : 0 };
}

// =================== Accounts ===================
const sessionsByToken = new Map(); // token -> user key

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
const makeToken = () => crypto.randomBytes(24).toString('hex');

// Stateless signed sessions: the token carries its own expiry and is verified by
// HMAC, so it survives server restarts / free-tier spin-downs (no in-memory state
// to lose) and stays valid for SESSION_TTL_MS before the user must log in again.
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const SESSION_SECRET = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_KEY || 'lms-fallback-session-secret';
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function signSession(key, isAdmin) {
  const payload = b64u(JSON.stringify({ k: key, a: isAdmin ? 1 : 0, exp: Date.now() + SESSION_TTL_MS }));
  const sig = b64u(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  return payload + '.' + sig;
}
function readSession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.indexOf('.'); if (dot < 1) return null;
  const payload = token.slice(0, dot), sig = token.slice(dot + 1);
  const expect = b64u(crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest());
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let obj; try { obj = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); } catch (e) { return null; }
  if (!obj || !obj.k || !obj.exp || Date.now() > obj.exp) return null;
  return obj;
}
const sessionKey = (token) => { const s = readSession(token); return s ? s.k : null; };

async function registerUser(username, password) {
  username = String(username || '').trim();
  if (username.length < 3 || username.length > 16) return { error: 'Username must be 3-16 characters.' };
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return { error: 'Use letters, numbers, and underscores only.' };
  if (String(password || '').length < 4) return { error: 'Password must be at least 4 characters.' };
  const key = username.toLowerCase();
  if (key === ADMIN_USER) return { error: 'That username is reserved.' };
  if (await store.getUser(key)) return { error: 'That username is already taken.' };
  const salt = crypto.randomBytes(16).toString('hex');
  const user = { username, username_lower: key, salt, hash: hashPw(password, salt),
                 credits: 0, wins: 0, created_at: new Date().toISOString() };
  try { await store.createUser(user); }
  catch (e) { if (e.message === 'DUPLICATE') return { error: 'That username is already taken.' }; throw e; }
  const token = signSession(key, key === ADMIN_USER);
  return { ok: true, token, username, credits: 0 };
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
  const token = signSession(key, key === ADMIN_USER);
  return { ok: true, token, username: u.username, credits: u.credits, admin: key === ADMIN_USER };
}

// =================== Credit safety (atomic, per-user) ===================
// Single Node process, so a per-user async lock serializes every balance change
// for a given user — this closes the read-modify-write races on credits.
const userLocks = new Map();
function withLock(key, fn) {
  const prev = userLocks.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);            // run fn after the previous op settles
  userLocks.set(key, run.then(() => {}, () => {}));
  return run;
}
// Add delta (may be negative) to a balance, floored at 0. Returns the new balance.
async function changeCredits(key, delta) {
  return withLock(key, async () => {
    const u = await store.getUser(key);
    if (!u) return 0;
    const nc = Math.max(0, (u.credits || 0) + Math.floor(delta));
    await store.updateCredits(key, nc);
    return nc;
  });
}
// Debit amount only if the balance covers it. Returns { ok, credits }.
async function debitIfEnough(key, amount) {
  return withLock(key, async () => {
    const u = await store.getUser(key);
    if (!u || (u.credits || 0) < amount) return { ok: false, credits: u ? (u.credits || 0) : 0 };
    const nc = (u.credits || 0) - amount;
    await store.updateCredits(key, nc);
    return { ok: true, credits: nc };
  });
}

// Basic in-memory rate limiting (per IP + bucket).
const rateHits = new Map();
function clientIp(req) { return ((req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim() || req.socket.remoteAddress || 'unknown'; }
function rateLimited(ip, bucket, max, windowMs) {
  const k = bucket + ':' + ip, now = Date.now();
  const arr = (rateHits.get(k) || []).filter(t => now - t < windowMs);
  if (arr.length >= max) { rateHits.set(k, arr); return true; }
  arr.push(now); rateHits.set(k, arr); return false;
}

// =================== Admin ===================
function isAdminToken(token) { const s = readSession(token); return !!(s && s.a); }

// A live snapshot of everything the admin portal needs: active games + online players.
function adminOverview() {
  const games = [...rooms.values()].map(r => ({
    code: r.code, phase: r.phase, wager: r.wager, pot: r.pot,
    roundTime: Math.floor(r.roundTime || 0),
    humans: humanCount(r), total: r.members.size, alive: aliveList(r).length,
    players: [...r.members.values()].map(s => ({
      name: s.username, bot: !!s.isBot,
      alive: !!(s.player && s.player.alive),
      credits: s.isBot ? null : (s.credits != null ? s.credits : null),
    })),
  }));
  const online = [...allSessions.values()].filter(s => s.username).map(s => ({
    username: s.username, credits: s.credits != null ? s.credits : null,
    room: s.room ? s.room.code : null, inGame: !!s.room,
    admin: s.key === ADMIN_USER,
  }));
  return { games, online, counts: { games: games.length, online: online.length }, serverTime: new Date().toISOString() };
}

// Reflect a credit change to a logged-in player instantly (if they're online).
function reflectCredits(key, credits) {
  const online = [...allSessions.values()].find(x => x.key === key);
  if (online) { online.credits = credits; try { online.conn.send(JSON.stringify({ t: 'credits', credits: credits })); } catch (e) {} }
}

async function adminAdjustCredits(username, delta) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return { error: 'Enter a username.' };
  delta = Math.floor(Number(delta) || 0);
  if (!delta) return { error: 'Enter a non-zero amount.' };
  const u = await store.getUser(key);
  if (!u) return { error: 'No user named "' + username + '".' };
  const newC = await changeCredits(key, delta);
  reflectCredits(key, newC);
  return { ok: true, username: u.username, credits: newC, delta };
}

async function adminHandleWithdrawal(id, action) {
  if (action !== 'approve' && action !== 'reject') return { error: 'Invalid action.' };
  const list = await store.listWithdrawals();
  const row = list.find(w => String(w.id) === String(id));
  if (!row) return { error: 'Request not found.' };
  if (row.status && row.status !== 'pending') return { error: 'Already ' + row.status + '.' };
  if (action === 'reject') {
    await store.setWithdrawalStatus(row.id, 'rejected');
    return { ok: true, id: row.id, status: 'rejected' };
  }
  // approve -> deduct the payout amount from the user's balance
  const key = row.username_lower;
  const u = await store.getUser(key);
  let newC = u ? (u.credits || 0) : 0;
  let deducted = 0;
  if (u) {
    deducted = Math.min(newC, row.amount);
    newC = newC - deducted;
    await store.updateCredits(key, newC);
    reflectCredits(key, newC);
  }
  await store.setWithdrawalStatus(row.id, 'approved');
  return { ok: true, id: row.id, status: 'approved', deducted, credits: newC };
}

// =================== BTCPay deposits ===================
const BTCPAY_URL = (process.env.BTCPAY_URL || '').replace(/\/+$/, '');
const BTCPAY_KEY = process.env.BTCPAY_API_KEY || '';
const BTCPAY_STORE = process.env.BTCPAY_STORE_ID || '';
const BTCPAY_WH_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || '';
function btcpayConfigured() { return !!(BTCPAY_URL && BTCPAY_KEY && BTCPAY_STORE); }

async function btcpayCreateInvoice(amountUsd, userKey) {
  const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/invoices', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'token ' + BTCPAY_KEY },
    body: JSON.stringify({
      amount: String(amountUsd), currency: 'USD',
      metadata: { username: userKey, orderId: 'dep-' + userKey + '-' + Date.now() },
      checkout: { redirectURL: 'https://lastduckstanding.io/' },
    }),
  });
  if (!r.ok) throw new Error('btcpay createInvoice ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function btcpayGetInvoice(invoiceId) {
  const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/invoices/' + invoiceId, {
    headers: { 'Authorization': 'token ' + BTCPAY_KEY },
  });
  if (!r.ok) throw new Error('btcpay getInvoice ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function handleDepositCreate(token, amount) {
  const key = sessionKey(token);
  if (!key) return { error: 'Please log in again.' };
  amount = Math.floor(Number(amount) || 0);
  if (amount < 1 || amount > 10000) return { error: 'Enter an amount between 1 and 10000.' };
  if (!btcpayConfigured()) return { error: 'Deposits are not enabled yet.' };
  let inv;
  try {
    inv = await btcpayCreateInvoice(amount, key);
  } catch (e) {
    console.error('deposit invoice failed:', e.message);
    if (/node not available|payment method unavailable|matching payment method/i.test(e.message)) {
      return { error: 'Deposits are warming up — the payment node is still syncing. Please try again in a bit.' };
    }
    return { error: 'Could not start the deposit right now. Please try again shortly.' };
  }
  try { await store.addTx({ username_lower: key, kind: 'deposit_pending', amount, room_code: inv.id }); } catch (e) {}
  return { ok: true, checkoutLink: inv.checkoutLink, invoiceId: inv.id };
}
// ---- Withdrawals (automated payouts) ----
const WITHDRAW_MIN = 10;     // USD/credits
const WITHDRAW_MAX = 1000;   // largest single auto-payout

async function btcpayCreatePayout(coin, address, usd, autoApprove) {
  const method = coin === 'LTC' ? 'LTC-CHAIN' : 'BTC-CHAIN';
  // approved:true -> the automated sender pays it right away. approved:false -> it sits in
  // BTCPay's "Awaiting approval" queue until the operator approves it (manual review for large cash-outs).
  const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/payouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'token ' + BTCPAY_KEY },
    body: JSON.stringify({ destination: address, amount: String(usd), payoutMethodId: method, approved: autoApprove !== false }),
  });
  if (!r.ok) throw new Error('btcpay createPayout ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function btcpayGetPayout(payoutId) {
  const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/payouts/' + payoutId, {
    headers: { 'Authorization': 'token ' + BTCPAY_KEY },
  });
  if (!r.ok) throw new Error('btcpay getPayout ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function handleWithdrawCreate(token, amount, coin, address) {
  const key = sessionKey(token);
  if (!key) return { error: 'Please log in again.' };
  amount = Math.floor(Number(amount) || 0);
  coin = (coin === 'LTC' || coin === 'BTC') ? coin : null;
  address = String(address || '').trim();
  if (!coin) return { error: 'Choose BTC or LTC.' };
  if (address.length < 20 || address.length > 120) return { error: 'Enter a valid ' + (coin || '') + ' address.' };
  if (amount < WITHDRAW_MIN) return { error: 'Minimum withdrawal is ' + WITHDRAW_MIN + ' credits.' };
  if (!btcpayConfigured()) return { error: 'Withdrawals are not enabled yet.' };
  // Small cash-outs pay out automatically. Anything above WITHDRAW_MAX is created in BTCPay's
  // "Awaiting approval" queue so the operator can manually review it before it's sent — players
  // never see this threshold; to them it's just a withdrawal being processed.
  const autoApprove = amount <= WITHDRAW_MAX;
  // Atomically debit the escrow — prevents concurrent withdrawals draining past balance.
  const deb = await debitIfEnough(key, amount);
  if (!deb.ok) return { error: 'You do not have enough credits.' };
  reflectCredits(key, deb.credits);
  let payout;
  try {
    payout = await btcpayCreatePayout(coin, address, amount, autoApprove);
  } catch (e) {
    console.error('withdraw payout failed:', e.message);
    const back = await changeCredits(key, amount);    // refund the escrow on failure
    reflectCredits(key, back);
    if (/node not available|payment method|not.*sync/i.test(e.message)) return { error: 'Withdrawals are warming up — the payout node is still syncing. Try again later.' };
    if (/destination|address|invalid|bip21/i.test(e.message)) return { error: 'That ' + coin + ' address looks invalid — double-check it.' };
    return { error: 'Could not start the withdrawal right now. Try again shortly.' };
  }
  try { await store.addTx({ username_lower: key, kind: 'withdraw', amount, room_code: payout.id }); } catch (e) {}
  const message = autoApprove
    ? '✓ Withdrawal sent — it pays out automatically to your wallet.'
    : '✓ Withdrawal requested — it\'s being processed and will land in your wallet shortly.';
  return { ok: true, payoutId: payout.id, credits: deb.credits, message };
}

// Verify the BTCPay-Sig HMAC over the raw body, then credit on a settled invoice (idempotent).
async function handleBtcpayWebhook(req, rawBody) {
  if (!BTCPAY_WH_SECRET) return 503;
  const sig = req.headers['btcpay-sig'] || '';
  const expected = 'sha256=' + crypto.createHmac('sha256', BTCPAY_WH_SECRET).update(rawBody, 'utf8').digest('hex');
  let ok = false;
  try { ok = sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); } catch (e) { ok = false; }
  if (!ok) return 400;
  let ev = {}; try { ev = JSON.parse(rawBody); } catch (e) { return 400; }
  if (ev.type === 'InvoiceSettled' && ev.invoiceId) {
    if (await store.txExists('deposit', ev.invoiceId)) return 200;   // already credited
    const inv = await btcpayGetInvoice(ev.invoiceId);
    const amt = Math.floor(Number(inv.amount) || 0);
    const key = inv.metadata && inv.metadata.username;
    if (key && amt > 0) {
      const newC = await changeCredits(key, amt);
      reflectCredits(key, newC);
      await store.addTx({ username_lower: key, kind: 'deposit', amount: amt, room_code: ev.invoiceId });
    }
  }
  // Payout was cancelled -> refund the player's escrowed credits (idempotent).
  if (ev.type && ev.type.indexOf('Payout') === 0 && ev.payoutId) {
    const p = await btcpayGetPayout(ev.payoutId);
    if (p && p.state === 'Cancelled' && !(await store.txExists('withdraw_refunded', ev.payoutId))) {
      const row = await store.getTx('withdraw', ev.payoutId);
      if (row) {
        const back = await changeCredits(row.username_lower, row.amount);
        reflectCredits(row.username_lower, back);
        await store.addTx({ username_lower: row.username_lower, kind: 'withdraw_refunded', amount: row.amount, room_code: ev.payoutId });
      }
    }
  }
  return 200;
}

// =================== Live crypto prices (deposit/withdraw converters) ===================
// Cached ~30s so we never hammer the price source. USD per 1 BTC / 1 LTC.
let ratesCache = { at: 0, btc: 0, ltc: 0 };
async function fetchRates() {
  const now = Date.now();
  if (now - ratesCache.at < 30000 && ratesCache.btc && ratesCache.ltc) return ratesCache;
  try {
    const [b, l] = await Promise.all([
      fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(r => r.json()),
      fetch('https://api.coinbase.com/v2/prices/LTC-USD/spot').then(r => r.json()),
    ]);
    const btc = Number(b && b.data && b.data.amount) || 0;
    const ltc = Number(l && l.data && l.data.amount) || 0;
    if (btc && ltc) ratesCache = { at: now, btc, ltc };
  } catch (e) { console.error('rates fetch failed:', e.message); }
  return ratesCache;
}

// =================== HTTP (static + auth/admin API) ===================
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/api/')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', async () => {
      // BTCPay webhook — verify the HMAC over the RAW body before anything else.
      if (req.url === '/api/btcpay/webhook') {
        try { const status = await handleBtcpayWebhook(req, body); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end('{}'); }
        catch (e) { console.error('btcpay webhook error:', e.message); res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{}'); }
        return;
      }
      let data = {}; try { data = JSON.parse(body || '{}'); } catch (e) {}
      const ip = clientIp(req);
      if ((req.url === '/api/register' && rateLimited(ip, 'register', 30, 3600000)) ||
          (req.url === '/api/login' && rateLimited(ip, 'login', 20, 600000)) ||
          (req.url === '/api/withdraw/create' && rateLimited(ip, 'withdraw', 8, 3600000)) ||
          (req.url === '/api/deposit/create' && rateLimited(ip, 'deposit', 30, 3600000))) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Too many requests — wait a moment and try again.' })); return;
      }
      try {
        // Admin routes require a valid admin session token.
        if (req.url.startsWith('/api/admin/')) {
          if (!isAdminToken(data.token)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Not authorized.' })); return;
          }
          let r;
          if (req.url === '/api/admin/overview') r = adminOverview();
          else if (req.url === '/api/admin/users') r = { ok: true, users: await store.listUsers() };
          else if (req.url === '/api/admin/credits') r = await adminAdjustCredits(data.username, data.delta);
          else if (req.url === '/api/admin/withdrawals') r = { ok: true, withdrawals: await store.listWithdrawals() };
          else if (req.url === '/api/admin/withdrawal') r = await adminHandleWithdrawal(data.id, data.action);
          else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
          res.writeHead(r && r.error ? 400 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r)); return;
        }
        let result;
        if (req.url === '/api/register') result = await registerUser(data.username, data.password);
        else if (req.url === '/api/login') result = await loginUser(data.username, data.password);
        else if (req.url === '/api/deposit/create') result = await handleDepositCreate(data.token, data.amount);
        else if (req.url === '/api/withdraw/create') result = await handleWithdrawCreate(data.token, data.amount, data.coin, data.address);
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
  // Live crypto prices for the deposit/withdraw converters.
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/rates') {
    fetchRates().then((r) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ btc: r.btc, ltc: r.ltc, at: r.at }));
    }).catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ btc: 0, ltc: 0 })); });
    return;
  }
  // Static files: serve ONLY these from the project root. An explicit allowlist
  // means server code, .env, and other files can never be fetched over the web.
  const STATIC = new Set(['index.html', 'client.js', 'admin.html']);
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (file === 'admin' || file === 'admin/') file = 'admin.html';   // pretty URL: /admin
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
const SCROLL_START = 27;    // px/sec at the start of a round
const SCROLL_RAMP = 2.1;    // added px/sec each second — gentle so the climb stays playable
const SCROLL_MAX = 118;     // hardest steady speed (still climbable; deaths come from misses/balls)
const PLAT_H = 16;
const GAP_MIN = 78, GAP_MAX = 104;   // vertical spacing between rungs (reachable by a jump)
const SPREAD = 110;                  // max horizontal shift between rungs — always within a jump's reach

// Hazards — uncontrollable bouncing balls that can knock ANYONE off, skill or not.
const HAZARD_R = 15, HAZARD_GRAV = 0.5, HAZARD_BOUNCE = -12.5;
const HAZARD_FIRST = 12, HAZARD_MAX = 4;           // calm opening: first ball at 12s, then ramps up
const KNOCK_VY = -8.5, KNOCK_SHOVE = 18, KNOCK_INVULN = 0.5;

const COLORS = ['#ff5252', '#ffb142', '#fff35c', '#32ff7e', '#18dcff',
                '#7d5fff', '#ff4d97', '#5ad1cd', '#ff9f43', '#badc58'];
const BOT_NAMES = ['Riley', 'Max', 'Nova', 'Kai', 'Zoe', 'Leo', 'Mia', 'Finn',
                   'Ivy', 'Jax', 'Luna', 'Ace', 'Remy', 'Sky', 'Theo', 'Wren',
                   'Echo', 'Bolt', 'Pixel', 'Dash'];

// =================== Matchmaking / rooms ===================
const rooms = new Map();         // code -> room
const allSessions = new Map();   // sessionId -> human session
let nextSessionId = 1;
// Matchmaking rooms are found by scanning the rooms map for a waiting room with the same wager.

function genCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); }
  while (rooms.has(c));
  return c;
}
function newPlayer() {
  return { x: 0, y: 0, vx: 0, vy: 0, alive: false, spectator: true,
           onPlatform: null, jumpHeld: false, color: '#fff', placedAt: 0, invuln: 0, hit: false,
           input: { left: false, right: false, jump: false } };
}
function humanCount(room) {
  let n = 0; for (const s of room.members.values()) if (!s.isBot) n++; return n;
}
function aliveList(room) {
  return [...room.members.values()].filter(s => s.player && s.player.alive && !s.player.spectator);
}

function createRoom(wager) {
  const code = genCode();
  const room = {
    code, members: new Map(), wager: wager || 0, pot: 0,
    phase: 'matchmaking',                 // matchmaking | countdown | playing | roundover
    fillTimer: MATCH_WAIT_S, phaseTimer: 0,
    roundTime: 0, winnerName: null, scrollSpeed: SCROLL_START,
    platforms: [], nextPlatId: 0, lastCenterX: WORLD.w / 2, tick: 0, eliminated: 0,
    hazards: [], nextHazardAt: HAZARD_FIRST,
  };
  rooms.set(code, room);
  return room;
}

function addToMatch(s, wager) {
  if (s.room) leaveMatch(s, true);
  let room = [...rooms.values()].find(r => r.phase === 'matchmaking' && r.wager === wager && humanCount(r) < MATCH_SIZE);
  if (!room) room = createRoom(wager);
  s.room = room; s.player = newPlayer();
  room.members.set(s.id, s);
  sendSearch(room);
  return room;
}
function leaveMatch(s, silent) {
  const room = s.room;
  if (!room) return;
  // Refund the escrowed wager only if the match has NOT started (still matchmaking).
  // Leaving once it's started forfeits the stake (it stays in the pot).
  if (s.wagerPaid > 0 && room.phase === 'matchmaking') {
    const k = s.key;
    changeCredits(k, s.wagerPaid).then(nc => { if (s.key === k) { s.credits = nc; } reflectCredits(k, nc); }).catch(() => {});
  }
  s.wagerPaid = 0;
  room.members.delete(s.id);
  s.room = null; s.player = null;
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
    ai: { skill: 0.8 + Math.random() * 0.2, jitter: (Math.random() - 0.5) * 9, aim: 14 + Math.random() * 26, retargetIn: 0, target: null },
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
  const w = width != null ? width : 135 + Math.floor(Math.random() * 85);
  const x = reachableX(room, w);
  const p = { id: room.nextPlatId++, x, y, w, h: PLAT_H, vx: 0, dx: 0 };
  if (moving) { p.homeX = x; p.amp = 18 + Math.random() * 18; p.phase = Math.random() * 6.283; p.spd = 0.018 + Math.random() * 0.018; }
  return p;
}
function setupRound(room) {
  room.roundTime = 0; room.winnerName = null; room.scrollSpeed = SCROLL_START;
  room.platforms = []; room.nextPlatId = 0; room.lastCenterX = WORLD.w / 2; room.eliminated = 0;
  room.hazards = []; room.nextHazardAt = HAZARD_FIRST;

  // Wide starting platform near the bottom so everyone has a clear place to begin.
  const base = { id: room.nextPlatId++, x: WORLD.w / 2 - 200, y: WORLD.h - 96, w: 400, h: PLAT_H, vx: 0, dx: 0 };
  room.platforms.push(base);
  // A guaranteed wide, centered first rung so EVERY spawn can climb off the base.
  const rung1 = { id: room.nextPlatId++, x: WORLD.w / 2 - 150, y: base.y - 92, w: 300, h: PLAT_H, vx: 0, dx: 0 };
  room.platforms.push(rung1);
  room.lastCenterX = WORLD.w / 2;

  // Build a stack of rungs upward (and a buffer above the screen) to climb.
  let y = rung1.y;
  let idx = 0;
  while (y > -160) {
    y -= GAP_MIN + Math.random() * (GAP_MAX - GAP_MIN);
    const moving = idx >= 3 && Math.random() < 0.45;   // first few rungs static for a reliable start
    room.platforms.push(makePlatform(room, y, null, moving));
    idx++;
  }

  // Spread players across the starting platform (rung 1 above is wide enough to reach from anywhere).
  const members = [...room.members.values()];
  const n = members.length;
  members.forEach((s, i) => {
    const p = s.player;
    p.spectator = false; p.alive = true; p.vx = 0; p.vy = 0;
    p.onPlatform = base.id; p.jumpHeld = false; p.color = COLORS[i % COLORS.length];
    p.placedAt = 0; p.invuln = 0; p.hit = false;
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
    if (p.amp != null) {   // gentle bounded sway — never drifts out of reach
      p.phase += p.spd;
      p.x = Math.max(0, Math.min(WORLD.w - p.w, p.homeX + Math.sin(p.phase) * p.amp));
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
    if (p.invuln > 0) p.invuln = Math.max(0, p.invuln - 1 / 60); else p.hit = false;

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

// =================== Hazards (bouncing balls) ===================
function spawnHazard(room) {
  room.hazards.push({
    x: HAZARD_R + Math.random() * (WORLD.w - 2 * HAZARD_R),
    y: -HAZARD_R - 10,
    vx: (2 + Math.random() * 2.5) * (Math.random() < 0.5 ? -1 : 1),
    vy: 2 + Math.random() * 2, r: HAZARD_R,
  });
}
function resetHazard(b) {
  b.x = HAZARD_R + Math.random() * (WORLD.w - 2 * HAZARD_R);
  b.y = -HAZARD_R - 10; b.vx = (2 + Math.random() * 2.5) * (Math.random() < 0.5 ? -1 : 1); b.vy = 2;
}
// Calm opening, hectic late: balls only appear after HAZARD_FIRST, then get faster and
// more numerous the longer the round runs and the more players are eliminated.
function hazardFactor(room) {
  const t = Math.max(0, room.roundTime - HAZARD_FIRST);
  return 1 + Math.min(1.7, t * 0.018 + room.eliminated * 0.07);
}
function targetHazards(room) {
  if (room.roundTime < HAZARD_FIRST) return 0;
  return Math.min(HAZARD_MAX, 1 + Math.floor((room.roundTime - HAZARD_FIRST) / 14) + Math.floor(room.eliminated / 4));
}
function stepHazards(room) {
  const scrollPx = room.scrollSpeed / 60;
  const hf = hazardFactor(room);
  for (const b of room.hazards) {
    b.vy += HAZARD_GRAV * hf;
    b.x += b.vx * hf;
    b.y += b.vy + scrollPx;
    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx) * (0.85 + Math.random() * 0.6); }
    if (b.x > WORLD.w - b.r) { b.x = WORLD.w - b.r; b.vx = -Math.abs(b.vx) * (0.85 + Math.random() * 0.6); }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * 0.6; }
    if (b.vy > 0) {
      for (const plat of room.platforms) {
        if (b.x + b.r > plat.x && b.x - b.r < plat.x + plat.w &&
            b.y + b.r >= plat.y && b.y + b.r <= plat.y + plat.h + 14) {
          b.y = plat.y - b.r;
          b.vy = HAZARD_BOUNCE * hf * (0.85 + Math.random() * 0.3);
          b.vx += (Math.random() * 2 - 1) * 2.4;            // unpredictable sideways kick on every bounce
          if (Math.random() < 0.18) b.vx = -b.vx;           // sometimes reverse outright — no learnable pattern
          b.vx = Math.max(-7, Math.min(7, b.vx));           // bounded so balls stay on-screen and fair
          break;
        }
      }
    }
    if (b.y - b.r > WORLD.h + 40) resetHazard(b);
    for (const s of room.members.values()) {
      const p = s.player;
      if (!p || !p.alive || p.spectator || p.invuln > 0) continue;
      const dx = (p.x + PW / 2) - b.x, dy = (p.y + PH / 2) - b.y;
      const rad = b.r + PW / 2;
      if (dx * dx + dy * dy < rad * rad) {
        const dir = dx >= 0 ? 1 : -1;
        p.x = Math.max(0, Math.min(WORLD.w - PW, p.x + dir * KNOCK_SHOVE));
        p.vx = dir * MOVE_MAX; p.vy = KNOCK_VY; p.onPlatform = null;
        p.invuln = KNOCK_INVULN; p.hit = true;
        b.vx = dir * Math.abs(b.vx); b.vy = HAZARD_BOUNCE * 0.7;
      }
    }
  }
}

// =================== Bot AI (competitive) ===================
function botThink(room, bot) {
  const p = bot.player;
  if (!p.alive || p.spectator) { p.input.left = p.input.right = p.input.jump = false; return; }
  const feet = p.y + PH, cx = p.x + PW / 2;

  const onGround = p.onPlatform != null;
  let best = bot.ai.target != null ? room.platforms.find(pl => pl.id === bot.ai.target) : null;
  if (best && best.y >= feet - 2) best = null;
  if (onGround || !best) {
    best = null; let bestScore = Infinity, nearest = null, nearGap = Infinity;
    for (const plat of room.platforms) {
      if (plat.y >= feet - 4) continue;
      if (plat.y < p.y - 168) continue;
      const gap = Math.abs((plat.x + plat.w / 2) - cx);
      if (gap < nearGap) { nearGap = gap; nearest = plat; }
      if (gap > 230) continue;
      const score = gap + (feet - plat.y) * 0.2;
      if (score < bestScore) { bestScore = score; best = plat; }
    }
    if (!best) best = nearest;
    if (!best) { let hi = Infinity; for (const plat of room.platforms) if (plat.y < hi && plat.y < feet) { hi = plat.y; best = plat; } }
    if (best) bot.ai.target = best.id;
  }
  let evade = 0;
  for (const b of room.hazards) {
    const bx = cx - b.x, by = (feet - PH / 2) - b.y;
    if (bx * bx + by * by < (b.r + 72) * (b.r + 72)) { evade = bx >= 0 ? 1 : -1; break; }
  }
  let goX = best ? (best.x + best.w / 2) : cx;
  if (evade) goX = cx + evade * 140;
  goX += bot.ai.jitter;
  const d = goX - cx;
  p.input.left = d < -4;
  p.input.right = d > 4;
  let wantJump = false;
  if (onGround) {
    const plat = room.platforms.find(pl => pl.id === p.onPlatform);
    if (best && best.y < feet - 6) {
      const tcx = best.x + best.w / 2;
      if (Math.abs(tcx - cx) < best.w / 2 + bot.ai.aim) wantJump = true;
      else if (plat) {
        if (tcx > cx && cx > plat.x + plat.w - 26) wantJump = true;
        if (tcx < cx && cx < plat.x + 26) wantJump = true;
      }
    }
    if (feet > WORLD.h - 58) wantJump = true;
    if (evade && feet > 150) wantJump = true;
  }
  p.input.jump = wantJump && !p.jumpHeld;
}

// =================== Match flow ===================
function startMatch(room) {
  fillWithBots(room);
  setupRound(room);
  // Wagers were already escrowed when each human joined (findMatch). The pot is the
  // sum of REAL wagers collected — bots add nothing, so the house never funds winnings.
  let collected = 0;
  for (const s of room.members.values()) if (!s.isBot && s.wagerPaid > 0) collected += s.wagerPaid;
  room.pot = collected;
  room.phase = 'countdown'; room.phaseTimer = COUNTDOWN_S;
  broadcastRoom(room);
}
function updateRoom(room, dt) {
  if (room.phase === 'matchmaking') {
    if (humanCount(room) === 0) { rooms.delete(room.code); return; }
    room.fillTimer -= dt;
    if (room.members.size >= MATCH_SIZE || room.fillTimer <= 0) startMatch(room);
    return;
  }
  if (humanCount(room) === 0) { rooms.delete(room.code); return; }

  if (room.phase === 'countdown') {
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) { room.phase = 'playing'; room.roundTime = 0; }
  } else if (room.phase === 'playing') {
    room.roundTime += dt;
    let ss = Math.min(SCROLL_MAX, SCROLL_START + room.roundTime * SCROLL_RAMP);
    if (room.roundTime > 80) ss = SCROLL_MAX + (room.roundTime - 80) * 4;   // sudden death failsafe — gentler, only kicks in very late
    room.scrollSpeed = ss;
    if (room.roundTime >= room.nextHazardAt && room.hazards.length < targetHazards(room)) {
      spawnHazard(room);
      const ramp = Math.max(0, room.roundTime - HAZARD_FIRST);
      room.nextHazardAt = room.roundTime + Math.max(2.0, 8.5 - room.eliminated * 0.4 - ramp * 0.06);
    }
    for (const s of room.members.values()) if (s.isBot) botThink(room, s);
    stepPhysics(room);
    stepHazards(room);
    const alive = aliveList(room);
    if (alive.length <= 1) {
      const winner = alive[0] || null;
      room.winnerName = winner ? winner.username : null;
      if (winner && !winner.isBot && winner.key) {
        let payout = 0;
        if (room.pot > 0) {
          payout = Math.floor(room.pot * 0.9);   // winner takes the pot (real stakes) minus 10% fee
          changeCredits(winner.key, payout).then(nc => { winner.credits = nc; }).catch(e => console.error('payout failed:', e.message));
        }
        store.recordWin(winner.key).then(w => { winner.wonStats = { wins: w, rank: rankFor(w), payout: payout }; })
          .catch(e => console.error('recordWin failed:', e.message));
      }
      room.phase = 'roundover'; room.phaseTimer = ROUNDOVER_S;
      broadcastRoom(room);
    }
  } else if (room.phase === 'roundover') {
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) {
      // Send humans home; the match (and its bots) dissolves.
      for (const s of room.members.values()) {
        if (!s.isBot) {
          const home = { t: 'home', credits: s.credits };
          if (s.wonStats) { home.wins = s.wonStats.wins; home.rank = s.wonStats.rank; home.won = true; home.payout = s.wonStats.payout; s.wonStats = null; }
          s.room = null; s.player = null;
          try { s.conn.send(JSON.stringify(home)); } catch (e) {}
        }
      }
      rooms.delete(room.code);

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
    wager: room.wager, pot: room.wager * humanCount(room),
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
    wager: room.wager, pot: room.pot,
    scroll: Math.round(room.scrollSpeed),
    platforms: room.platforms.map(p => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h })),
    hazards: room.hazards.map(b => ({ x: Math.round(b.x), y: Math.round(b.y), r: b.r })),
    players: [...room.members.values()].map(s => ({
      id: s.username, name: s.username, color: s.player.color,
      x: Math.round(s.player.x), y: Math.round(s.player.y),
      alive: s.player.alive, spectator: s.player.spectator, vx: Math.round(s.player.vx),
      hit: !!s.player.hit,
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

  conn.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'auth') {
      const key = sessionKey(m.token);
      if (!key) { conn.send(JSON.stringify({ t: 'authfail' })); return; }
      store.getUser(key).then((u) => {
        if (!u) { conn.send(JSON.stringify({ t: 'authfail' })); return; }
        s.username = u.username; s.key = key; s.credits = u.credits;
        conn.send(JSON.stringify({ t: 'authed', username: u.username, credits: u.credits, wins: u.wins || 0, rank: rankFor(u.wins || 0) }));
      }).catch((e) => {
        console.error('auth lookup failed:', e.message);
        conn.send(JSON.stringify({ t: 'authfail' }));
      });
      return;
    }
    if (!s.username) return; // everything below requires auth

    if (m.t === 'findMatch') {
      if (s.room) leaveMatch(s, true);                 // leave (and refund) any current queue first
      const wager = [5, 10, 50, 100].indexOf(Number(m.wager)) >= 0 ? Number(m.wager) : 0;
      if (wager > 0) {
        const deb = await debitIfEnough(s.key, wager); // escrow the stake on join (atomic)
        if (!deb.ok) { try { conn.send(JSON.stringify({ t: 'matchError', error: 'Not enough credits for that wager.' })); } catch (e) {} return; }
        s.credits = deb.credits; s.wagerPaid = wager;
        try { conn.send(JSON.stringify({ t: 'credits', credits: deb.credits })); } catch (e) {}
      } else { s.wagerPaid = 0; }
      addToMatch(s, wager);
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
  console.log('Last Duck Standing running at  http://localhost:' + PORT);
  console.log('Accounts storage: ' + (store.backend === 'supabase' ? 'Supabase (Postgres)' : 'local file (data/users.json)'));
  console.log('Sign in, hit Find Match — bots fill any empty slots so a game always starts.');
});

// Exported for the automated tests.
module.exports = { server };
