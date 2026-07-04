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

// Numeric levels — you go up one level every 5 wins (0-4 = Lv1, 5-9 = Lv2, ...). Uncapped.
function rankFor(wins) {
  const w = wins || 0;
  const level = Math.floor(w / 5) + 1;
  return { level: level, tier: 'Level ' + level, toNext: 5 - (w % 5) };
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
  if (maintenanceOn()) return { error: 'New sign-ups are paused for maintenance. Please check back soon.' };
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
  if (u.banned && key !== ADMIN_USER) return { error: 'This account has been suspended.' + (u.banned_reason ? ' Reason: ' + u.banned_reason : '') };
  if (maintenanceOn() && key !== ADMIN_USER) return { error: 'Last Duck Standing is under maintenance. Please check back soon.' };
  store.setUserFields(key, { last_seen: new Date().toISOString() }).catch(() => {});
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
  // Real withdrawals are handled entirely by the automated BTCPay payout flow (handleWithdrawCreate),
  // which already escrows/debits the credits when the player requests the cash-out. This legacy manual
  // queue ONLY updates a status label — it must never move credits (doing so would double-debit the
  // player) and it does not send any crypto. Kept as a harmless no-op to avoid breaking the admin page.
  const status = action === 'reject' ? 'rejected' : 'approved';
  await store.setWithdrawalStatus(row.id, status);
  return { ok: true, id: row.id, status, deducted: 0 };
}

// =================== Admin suite: settings, metrics, moderation ===================
let APP_SETTINGS = {};
async function loadSettings() { try { APP_SETTINGS = (await store.getSettings()) || {}; } catch (e) {} }
loadSettings(); setInterval(loadSettings, 15000);
function settingBool(k) { return /^(1|true|on|yes)$/i.test(String(APP_SETTINGS[k] || '')); }
function maintenanceOn() { return settingBool('maintenance_mode'); }

// Rolling peak of concurrent authenticated players (resets on restart).
let peakOnline = 0;
setInterval(() => { let n = 0; for (const s of allSessions.values()) if (s.username) n++; if (n > peakOnline) peakOnline = n; }, 5000);

function adminAudit(token, action, target, detail) {
  let admin = '?'; try { const s = readSession(token); if (s) admin = s.k; } catch (e) {}
  store.addAudit({ admin: admin, action: action, target: target || null,
    detail: detail == null ? null : (typeof detail === 'string' ? detail : JSON.stringify(detail)) }).catch(() => {});
}

function liveCounts() {
  let online = 0, searching = 0, playing = 0;
  for (const s of allSessions.values()) {
    if (!s.username) continue; online++;
    if (s.room) { if (s.room.phase === 'matchmaking' || s.room.phase === 'lobby') searching++; else playing++; }
  }
  let bots = 0, cashGames = 0, potLive = 0;
  for (const r of rooms.values()) {
    for (const m of r.members.values()) if (m.isBot) bots++;
    if (r.wager > 0) { cashGames++; potLive += r.pot || 0; }
  }
  return { online, searching, playing, bots, cashGames, potLive };
}

function serverHealth() {
  const mem = process.memoryUsage(); const lc = liveCounts();
  return {
    uptime: Math.floor(process.uptime()),
    rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576), heapTotal: Math.round(mem.heapTotal / 1048576),
    sessions: allSessions.size, humans: lc.online, bots: lc.bots, rooms: rooms.size,
    node: process.version, backend: store.backend, btcpay: btcpayConfigured(),
    geoEnforce: GEO_ENFORCE, geoBlock: [...GEO_BLOCK], originLock: ORIGIN_LOCK,
    maintenance: maintenanceOn(), peakOnline: peakOnline, tickMs: TICK_MS, serverTime: new Date().toISOString(),
  };
}

async function adminMetrics() {
  const [fin, eco] = await Promise.all([
    store.rpc('admin_finance').catch(() => ({})),
    store.rpc('admin_economy').catch(() => ({})),
  ]);
  const rates = await fetchRates().catch(() => ({ btc: 0, ltc: 0 }));
  const wds = await store.listWithdrawals().catch(() => []);
  let pendPayoutCount = 0, pendPayoutAmt = 0;
  for (const w of wds) if ((w.status || 'pending') === 'pending') { pendPayoutCount++; pendPayoutAmt += w.amount || 0; }
  const depCredits = (fin && fin.deposit_credits) || 0;
  const feeRevenue = Math.round(depCredits * (DEPOSIT_FEE / (1 - DEPOSIT_FEE)));
  return {
    ok: true, finance: fin || {}, economy: eco || {}, live: liveCounts(), peakOnline: peakOnline,
    feeRevenue: feeRevenue, grossDeposits: depCredits + feeRevenue,
    pendingPayouts: { count: pendPayoutCount, amount: pendPayoutAmt },
    rates: rates, health: serverHealth(), tax: await taxSummary(fin), serverTime: new Date().toISOString(),
  };
}

// ---- Tax estimator (record-keeping aid, NOT tax advice) ----
// Basis = ALL deposits received (gross income) minus withdrawals actually paid out (a deduction).
// Refunded cash-outs are removed from the deduction since that money never left. A US citizen owes
// US tax on worldwide income even via a zero-tax foreign company — this is a planning estimate only.
function taxRate() { const r = parseFloat(APP_SETTINGS['tax_rate'] || '0.37'); return (isFinite(r) && r >= 0 && r <= 1) ? r : 0.37; }
async function taxSummary(finMaybe) {
  const tax = await store.rpc('admin_tax').catch(() => ({}));
  const fin = finMaybe || await store.rpc('admin_finance').catch(() => ({}));
  const depositGross = tax.deposit_gross || 0;
  const withdrawPaid = tax.withdraw_paid || 0;
  const refunds = fin.refunded_amt || 0;
  const deduction = Math.max(0, withdrawPaid - refunds);
  const netBasis = depositGross - deduction;
  const rate = taxRate();
  const estTax = Math.round(Math.max(0, netBasis) * rate);
  return { depositGross, withdrawPaid, refunds, deduction, netBasis, rate, estTax,
    depositCount: tax.deposit_count || 0, withdrawCount: tax.withdraw_count || 0, eventCount: tax.event_count || 0 };
}
async function adminTax() {
  return { ok: true, summary: await taxSummary(), events: await store.listTaxEvents(1000).catch(() => []) };
}

function riskFlags(u, depSum, wdSum) {
  const f = [];
  if (u.banned) f.push({ level: 'danger', text: 'Account is banned' });
  if ((u.credits || 0) >= 5000) f.push({ level: 'watch', text: 'High balance (' + (u.credits || 0) + ')' });
  if (wdSum > depSum && wdSum > 0) f.push({ level: 'warn', text: 'Withdrawn (' + wdSum + ') exceeds deposited (' + depSum + ')' });
  if ((u.credits || 0) > 500 && depSum === 0 && (u.wins || 0) === 0) f.push({ level: 'watch', text: 'Balance with no deposits and no wins' });
  return f;
}

async function adminUserProfile(username) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return { error: 'Enter a username.' };
  const u = await store.getUser(key);
  if (!u) return { error: 'No user named "' + username + '".' };
  const tx = await store.listTxByUser(key).catch(() => []);
  const allWd = await store.listWithdrawals().catch(() => []);
  const wds = allWd.filter(w => w.username_lower === key);
  const depSum = tx.filter(t => t.kind === 'deposit').reduce((a, t) => a + (t.amount || 0), 0);
  const wdSum = tx.filter(t => t.kind === 'withdraw').reduce((a, t) => a + (t.amount || 0), 0);
  const online = findOnlineByKey(key);
  return {
    ok: true,
    user: {
      username: u.username, key: key, credits: u.credits, wins: u.wins || 0, rank: rankFor(u.wins || 0),
      created_at: u.created_at, banned: !!u.banned, banned_reason: u.banned_reason || null, banned_at: u.banned_at || null,
      flagged: !!u.flagged, admin_note: u.admin_note || null, last_seen: u.last_seen || null,
      online: !!online, inGame: !!(online && online.room), room: (online && online.room) ? online.room.code : null,
      depositTotal: depSum, withdrawTotal: wdSum,
    },
    tx: tx.slice(0, 50), withdrawals: wds, risk: riskFlags(u, depSum, wdSum),
  };
}

async function adminSearch(q) {
  q = String(q || '').trim();
  if (!q) return { ok: true, users: [] };
  return { ok: true, users: await store.searchUsers(q, 25).catch(() => []) };
}

function findOnlineByKey(key) { return [...allSessions.values()].find(s => s.key === key); }

async function adminBan(token, username, reason) {
  const key = String(username || '').trim().toLowerCase();
  if (!key) return { error: 'Enter a username.' };
  if (key === ADMIN_USER) return { error: 'You cannot ban the admin account.' };
  const u = await store.getUser(key);
  if (!u) return { error: 'No user named "' + username + '".' };
  await store.setUserFields(key, { banned: true, banned_reason: String(reason || '').slice(0, 300) || 'No reason given', banned_at: new Date().toISOString() });
  const s = findOnlineByKey(key);
  if (s) { try { leaveMatch(s, true); } catch (e) {} try { s.conn.send(JSON.stringify({ t: 'banned', reason: reason || '' })); } catch (e) {} setTimeout(() => { try { s.conn.close(); } catch (e) {} }, 400); }
  adminAudit(token, 'ban', key, { reason: reason || '' });
  return { ok: true, username: u.username, banned: true };
}
async function adminUnban(token, username) {
  const key = String(username || '').trim().toLowerCase();
  const u = await store.getUser(key);
  if (!u) return { error: 'No user named "' + username + '".' };
  await store.setUserFields(key, { banned: false, banned_reason: null, banned_at: null });
  adminAudit(token, 'unban', key, null);
  return { ok: true, username: u.username, banned: false };
}
async function adminSetNote(token, username, note) {
  const key = String(username || '').trim().toLowerCase();
  const u = await store.getUser(key);
  if (!u) return { error: 'No user named "' + username + '".' };
  await store.setUserFields(key, { admin_note: String(note || '').slice(0, 1000) || null });
  adminAudit(token, 'note', key, null);
  return { ok: true, username: u.username };
}
async function adminSetFlag(token, username, flagged) {
  const key = String(username || '').trim().toLowerCase();
  const u = await store.getUser(key);
  if (!u) return { error: 'No user named "' + username + '".' };
  await store.setUserFields(key, { flagged: !!flagged });
  adminAudit(token, flagged ? 'flag' : 'unflag', key, null);
  return { ok: true, username: u.username, flagged: !!flagged };
}
async function adminKick(token, username) {
  const key = String(username || '').trim().toLowerCase();
  const s = findOnlineByKey(key);
  if (!s) return { error: 'That player is not online.' };
  try { leaveMatch(s, false); } catch (e) {}
  adminAudit(token, 'kick', key, null);
  return { ok: true, username: s.username };
}
async function adminVoidGame(token, code) {
  code = String(code || '').toUpperCase();
  const room = rooms.get(code);
  if (!room) return { error: 'No active game "' + code + '".' };
  let refunded = 0, players = 0;
  for (const s of room.members.values()) {
    if (s.isBot) continue; players++;
    if (s.wagerPaid > 0) {
      const k = s.key, amt = s.wagerPaid; refunded += amt;
      try { const nc = await changeCredits(k, amt); s.credits = nc; reflectCredits(k, nc); } catch (e) {}
    }
    s.wagerPaid = 0; s.room = null; s.player = null; s.ready = false;
    try { s.conn.send(JSON.stringify({ t: 'home', voided: true, credits: s.credits })); } catch (e) {}
  }
  try { killRoom(room); } catch (e) {}
  rooms.delete(code);
  adminAudit(token, 'void_game', code, { refunded: refunded, players: players });
  return { ok: true, code: code, refunded: refunded, players: players };
}
function adminBroadcast(token, text, level) {
  text = String(text || '').slice(0, 240);
  level = ['info', 'warn', 'alert'].indexOf(level) >= 0 ? level : 'info';
  let sent = 0;
  const msg = JSON.stringify({ t: 'sysbanner', text: text, level: level });
  for (const s of allSessions.values()) { if (!s.username) continue; try { s.conn.send(msg); sent++; } catch (e) {} }
  store.setSetting('announcement', text).catch(() => {});
  store.setSetting('announcement_active', text ? 'true' : 'false').catch(() => {});
  store.setSetting('announcement_level', level).catch(() => {});
  loadSettings();
  adminAudit(token, 'broadcast', null, { text: text, level: level, sent: sent });
  return { ok: true, sent: sent };
}
async function adminSetSetting(token, key, value) {
  const allowed = ['maintenance_mode', 'maintenance_message', 'announcement', 'announcement_active', 'announcement_level', 'tax_rate'];
  if (allowed.indexOf(key) < 0) return { error: 'Unknown setting.' };
  await store.setSetting(key, value);
  await loadSettings();
  if (key === 'maintenance_mode' && settingBool('maintenance_mode')) {
    const note = APP_SETTINGS['maintenance_message'] || 'The site is temporarily under maintenance.';
    const msg = JSON.stringify({ t: 'sysbanner', text: '🛠 ' + note, level: 'alert' });
    for (const s of allSessions.values()) { if (s.username && s.key !== ADMIN_USER) try { s.conn.send(msg); } catch (e) {} }
  }
  adminAudit(token, 'setting', key, { value: String(value) });
  return { ok: true, settings: APP_SETTINGS };
}

// =================== BTCPay deposits ===================
const BTCPAY_URL = (process.env.BTCPAY_URL || '').replace(/\/+$/, '');
const BTCPAY_KEY = process.env.BTCPAY_API_KEY || '';
const BTCPAY_STORE = process.env.BTCPAY_STORE_ID || '';
const BTCPAY_WH_SECRET = process.env.BTCPAY_WEBHOOK_SECRET || '';
const DEPOSIT_FEE = 0.015;           // platform takes 1.5% of every deposit
const CONFIRMS_TARGET = 2;           // confirmations a deposit/withdrawal needs to be "completed"
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
  let payments = [];
  try { payments = parseInvoicePayments(await btcpayGetInvoicePMs(inv.id)); } catch (e) {}
  return { ok: true, checkoutLink: inv.checkoutLink, invoiceId: inv.id, payments };
}
// ---- Withdrawals (automated payouts) ----
const WITHDRAW_MIN = 10;     // USD/credits
const WITHDRAW_MAX = 1000;   // largest single auto-payout

async function btcpayCreatePayout(coin, address, cryptoAmount, autoApprove, ref) {
  const method = coin === 'LTC' ? 'LTC-CHAIN' : 'BTC-CHAIN';
  // approved:true -> the automated sender pays it right away. approved:false -> it sits in
  // BTCPay's "Awaiting approval" queue until the operator approves it (manual review for large cash-outs).
  // `ref` is a per-request idempotency tag stored in metadata so we can detect a payout that landed
  // even if the HTTP response was lost — preventing a refund-AND-send double spend.
  const body = { destination: address, amount: String(cryptoAmount), payoutMethodId: method, approved: autoApprove !== false };
  if (ref) body.metadata = { withdrawRef: ref };
  const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/payouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'token ' + BTCPAY_KEY },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error('btcpay createPayout ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
// Did a payout with this idempotency ref actually get created? (Used after an ambiguous network failure.)
async function btcpayFindPayoutByRef(ref) {
  if (!ref) return null;
  try {
    const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/payouts?includeCancelled=true', {
      headers: { 'Authorization': 'token ' + BTCPAY_KEY },
    });
    if (!r.ok) return null;
    const list = await r.json();
    return (Array.isArray(list) ? list : []).find(p => p.metadata && p.metadata.withdrawRef === ref) || null;
  } catch (e) { return null; }
}
async function btcpayGetPayout(payoutId) {
  const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/payouts/' + payoutId, {
    headers: { 'Authorization': 'token ' + BTCPAY_KEY },
  });
  if (!r.ok) throw new Error('btcpay getPayout ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function btcpayGetInvoicePMs(invoiceId) {
  try {
    const r = await fetch(BTCPAY_URL + '/api/v1/stores/' + BTCPAY_STORE + '/invoices/' + invoiceId + '/payment-methods', {
      headers: { 'Authorization': 'token ' + BTCPAY_KEY },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d) ? d : [];
  } catch (e) { return []; }
}

// ---- On-chain confirmation lookup via public explorers (display only; crediting stays BTCPay-driven) ----
const EXPLORER = { BTC: 'https://blockstream.info/api', LTC: 'https://litecoinspace.org/api' };
const tipCache = { BTC: { h: 0, at: 0 }, LTC: { h: 0, at: 0 } };
async function tipHeight(coin) {
  const c = coin === 'LTC' ? 'LTC' : 'BTC';
  const now = Date.now();
  if (now - tipCache[c].at < 30000 && tipCache[c].h) return tipCache[c].h;
  try {
    const r = await fetch(EXPLORER[c] + '/blocks/tip/height');
    const h = parseInt(await r.text(), 10);
    if (h > 0) tipCache[c] = { h, at: now };
  } catch (e) {}
  return tipCache[c].h;
}
async function txConfirmations(coin, txid) {
  if (!txid) return null;
  const c = coin === 'LTC' ? 'LTC' : 'BTC';
  try {
    const r = await fetch(EXPLORER[c] + '/tx/' + encodeURIComponent(txid));
    if (!r.ok) return null;
    const tx = await r.json();
    if (!tx.status || !tx.status.confirmed) return 0;        // seen in mempool, 0 confirmations
    const tip = await tipHeight(c);
    if (!tip || !tx.status.block_height) return 1;
    return Math.max(1, tip - tx.status.block_height + 1);
  } catch (e) { return null; }
}
function pmCoin(pm) { return /LTC/i.test(pm.paymentMethodId || pm.paymentMethod || pm.cryptoCode || '') ? 'LTC' : 'BTC'; }
// Clean, client-ready payment details for an invoice's on-chain methods (address, amount, BIP21 URI).
function parseInvoicePayments(pms) {
  const out = [];
  for (const pm of (pms || [])) {
    const coin = pmCoin(pm);
    const address = pm.destination || pm.address || '';
    const amount = String(pm.due != null && pm.due !== '' ? pm.due : (pm.amount != null ? pm.amount : (pm.totalDue || '')));
    if (!address) continue;
    const uri = pm.paymentLink || ((coin === 'LTC' ? 'litecoin:' : 'bitcoin:') + address + (amount ? ('?amount=' + amount) : ''));
    out.push({ coin, address, amount, uri, rate: pm.rate != null ? String(pm.rate) : null });
  }
  return out;
}
async function handleDepositDetails(token, invoiceId) {
  const key = sessionKey(token);
  if (!key) return { error: 'Please log in again.' };
  if (!btcpayConfigured()) return { error: 'Deposits are not enabled yet.' };
  invoiceId = String(invoiceId || '');
  try {
    const rows = await store.listTxByUser(key);
    const owns = (rows || []).some(r => r.kind === 'deposit_pending' && String(r.room_code) === invoiceId);
    if (!owns) return { error: 'Invoice not found.' };
    const inv = await btcpayGetInvoice(invoiceId);
    const st = String(inv.status || '').toLowerCase();
    const payments = parseInvoicePayments(await btcpayGetInvoicePMs(invoiceId));
    return { ok: true, invoiceId, status: st, expired: (st === 'expired' || st === 'invalid'),
             settled: (st === 'settled' || st === 'complete' || st === 'confirmed'),
             checkoutLink: inv.checkoutLink, payments };
  } catch (e) { return { error: 'Could not load that invoice.' }; }
}
function firstTxid(payments) {
  for (const p of (payments || [])) {
    const raw = p.id || p.transactionId || p.txId || p.destination || '';
    const id = String(raw).split(/[-:]/)[0];
    if (id && id.length >= 20) return id;
  }
  return null;
}
function payoutTxid(po) {
  const pr = po && (po.proof || po.paymentProof);
  if (!pr) return null;
  const raw = pr.id || pr.txId || pr.txid || (pr.link ? pr.link.split('/').pop() : '') || '';
  const id = String(raw).split(/[-:?#]/)[0];
  return id && id.length >= 20 ? id : null;
}

// ---- Deposit + withdrawal history with live status/confirmations ----
async function handleHistory(token) {
  const key = sessionKey(token);
  if (!key) return { error: 'Please log in again.' };
  let rows;
  try { rows = await store.listTxByUser(key); } catch (e) { console.error('history list failed:', e.message); return { error: 'Could not load history.' }; }
  rows = rows || [];
  const settledDep = new Set(rows.filter(r => r.kind === 'deposit').map(r => String(r.room_code)));
  const doneWd = new Set(rows.filter(r => r.kind === 'withdraw_done').map(r => String(r.room_code)));
  const refundWd = new Set(rows.filter(r => r.kind === 'withdraw_refunded').map(r => String(r.room_code)));

  const deposits = [];
  for (const r of rows.filter(r => r.kind === 'deposit')) {
    deposits.push({ amount: r.amount, date: r.created_at, status: 'completed', confs: CONFIRMS_TARGET, target: CONFIRMS_TARGET });
  }
  for (const r of rows.filter(r => r.kind === 'deposit_pending' && !settledDep.has(String(r.room_code)))) {
    let status = 'pending', confs = null, coin = null;
    if (btcpayConfigured()) {
      try {
        const inv = await btcpayGetInvoice(r.room_code);
        const s = String(inv.status || '').toLowerCase();
        if (s === 'settled' || s === 'complete' || s === 'confirmed') { status = 'completed'; confs = CONFIRMS_TARGET; }
        else if (s === 'expired' || s === 'invalid') { status = 'expired'; }
        else if (s === 'processing' || s === 'paid') {
          status = 'confirming';
          const pms = await btcpayGetInvoicePMs(r.room_code);
          const paid = pms.find(pm => (pm.payments || []).length > 0) || pms[0];
          if (paid) { coin = pmCoin(paid); confs = await txConfirmations(coin, firstTxid(paid.payments)); }
        }
      } catch (e) {}
    }
    deposits.push({ amount: r.amount, date: r.created_at, status, confs, target: CONFIRMS_TARGET, coin, invoiceId: r.room_code });
  }

  const withdrawals = [];
  for (const r of rows.filter(r => r.kind === 'withdraw')) {
    const id = String(r.room_code);
    if (refundWd.has(id)) { withdrawals.push({ amount: r.amount, date: r.created_at, status: 'refunded', target: CONFIRMS_TARGET }); continue; }
    if (doneWd.has(id)) { withdrawals.push({ amount: r.amount, date: r.created_at, status: 'completed', confs: CONFIRMS_TARGET, target: CONFIRMS_TARGET }); continue; }
    let status = 'sending', confs = null, coin = null;
    if (btcpayConfigured()) {
      try {
        const po = await btcpayGetPayout(id);
        const st = String(po.state || '').toLowerCase();
        coin = /LTC/i.test(po.payoutMethodId || po.paymentMethod || '') ? 'LTC' : 'BTC';
        if (st === 'completed') { status = 'completed'; confs = CONFIRMS_TARGET; store.addTx({ username_lower: key, kind: 'withdraw_done', amount: r.amount, room_code: id }).catch(() => {}); }
        else if (st === 'awaitingapproval') status = 'review';
        else if (st === 'cancelled') status = 'cancelled';
        else { // awaitingpayment / inprogress
          status = 'sending';
          const c = await txConfirmations(coin, payoutTxid(po));
          if (c != null) { confs = c; status = 'confirming'; }
        }
      } catch (e) {}
    }
    withdrawals.push({ amount: r.amount, date: r.created_at, status, confs, target: CONFIRMS_TARGET, coin });
  }
  return { ok: true, deposits, withdrawals };
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
  const ref = crypto.randomBytes(12).toString('hex');   // idempotency tag for this withdrawal
  let payout, txRate = null, txCrypto = null;
  try {
    // BTCPay's store payout endpoint treats `amount` as the payout method's NATIVE unit (BTC/LTC),
    // NOT dollars. So convert the USD credit amount to crypto with the live rate before sending —
    // otherwise "13 credits" would request 13 BTC.
    const rates = await fetchRates();
    const rate = coin === 'LTC' ? rates.ltc : rates.btc;
    if (!rate || rate <= 0) throw new Error('rate unavailable');
    const cryptoAmt = (amount / rate).toFixed(8);
    txRate = rate; txCrypto = cryptoAmt;
    payout = await btcpayCreatePayout(coin, address, cryptoAmt, autoApprove, ref);
  } catch (e) {
    console.error('withdraw payout failed:', e.message);
    // The create may have SUCCEEDED but the response was lost (network blip). Before refunding, check
    // whether a payout with our ref actually landed — if so, keep the escrow and record it, so we never
    // refund the credits AND send the crypto.
    const landed = await btcpayFindPayoutByRef(ref);
    if (landed && landed.id) { payout = landed; }
    else {
      const back = await changeCredits(key, amount);    // truly failed -> refund the escrow
      reflectCredits(key, back);
      if (/rate unavailable/i.test(e.message)) return { error: 'Price feed is momentarily down — try again in a few seconds.' };
      if (/node not available|payment method|not.*sync/i.test(e.message)) return { error: 'Withdrawals are warming up — the payout node is still syncing. Try again later.' };
      if (/destination|address|invalid|bip21/i.test(e.message)) return { error: 'That ' + coin + ' address looks invalid — double-check it.' };
      return { error: 'Could not start the withdrawal right now. Try again shortly.' };
    }
  }
  try { await store.addTx({ username_lower: key, kind: 'withdraw', amount, room_code: payout.id }); } catch (e) {}
  // Tax ledger: record the cash-out (a deduction) with the crypto amount + live market price at this moment.
  try { await store.addTaxEvent({ kind: 'withdrawal', username_lower: key, coin: coin, crypto_amount: txCrypto ? Number(txCrypto) : null, usd_value: amount, market_price: txRate, ref: String(payout.id) }); } catch (e) {}
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
      const credited = Math.max(0, Math.floor(amt * (1 - DEPOSIT_FEE)));   // platform takes a 1.5% deposit fee
      const newC = await changeCredits(key, credited);
      reflectCredits(key, newC);
      await store.addTx({ username_lower: key, kind: 'deposit', amount: credited, room_code: ev.invoiceId });
      // Tax ledger: record the deposit at GROSS value received (income), with a live BTC price reference.
      try { const rt = await fetchRates(); await store.addTaxEvent({ kind: 'deposit', username_lower: key, coin: null, crypto_amount: null, usd_value: amt, market_price: (rt && rt.btc) || null, ref: String(ev.invoiceId) }); } catch (e) {}
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

// ===== Geo-fencing: block real-money-prohibited regions (US + territories by default). =====
// Configurable without a redeploy via the GEO_BLOCK env var (comma-separated ISO country codes).
const GEO_BLOCK = new Set(String(process.env.GEO_BLOCK || 'US,PR,GU,VI,AS,MP,UM')
  .split(',').map(s => s.trim().toUpperCase()).filter(Boolean));
// Owner/staff bypass secret: visiting with ?geo=SECRET drops a cookie so you (even in a blocked
// region) keep full access to your own site. Set GEO_BYPASS in the Render env to enable it.
const GEO_BYPASS = process.env.GEO_BYPASS || '';
function geoBypassed(req) {
  if (!GEO_BYPASS) return false;
  if ((req.url || '').indexOf('geo=' + GEO_BYPASS) >= 0) return true;
  return String(req.headers.cookie || '').indexOf('geo=' + GEO_BYPASS) >= 0;
}
// Cloudflare stamps CF-IPCountry on every proxied request. We block only EXPLICIT matches — a missing
// header (Render's internal health check, or any direct-to-origin hit) is left alone so the app never
// self-locks. The Cloudflare edge rule is the primary enforcer; this app check is defense-in-depth.
// Master switch — the block does nothing until GEO_ENFORCE is turned on in the env. Lets us deploy
// the code safely, set the bypass, then flip enforcement on without any risk of self-lockout.
const GEO_ENFORCE = /^(1|true|on|yes)$/i.test(String(process.env.GEO_ENFORCE || ''));
function geoBlocked(req) {
  if (!GEO_ENFORCE) return false;
  const c = String(req.headers['cf-ipcountry'] || '').toUpperCase();
  if (!c || !GEO_BLOCK.has(c)) return false;
  return !geoBypassed(req);
}
// Turn a 2-letter ISO country code into a human-readable region name. Intl.DisplayNames covers every
// country automatically, so ANY code added to GEO_BLOCK renders a proper name with no code changes.
let REGION_NAMES = null;
try { REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' }); } catch (e) { REGION_NAMES = null; }
// Regions that read naturally with a leading "the" (e.g. "the United States").
const THE_REGIONS = new Set(['US','GB','UK','AE','NL','PH','DO','CZ','BS','GM','CD','CG','CF','KY','VI','GU','UM','MP','TC','VG','CI']);
// The default block set are all under United States law — used to give US-specific wording.
const US_FAMILY = new Set(['US','PR','GU','VI','AS','MP','UM']);
function regionLabel(cc) {
  if (!cc) return 'your region';
  let name = null;
  if (REGION_NAMES) { try { const n = REGION_NAMES.of(cc); if (n && n !== cc) name = n; } catch (e) {} }
  if (!name) return 'your region (' + cc + ')';
  return (THE_REGIONS.has(cc) ? 'the ' : '') + name;
}
function geoBlockPage(ccRaw) {
  const cc = String(ccRaw || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
  const region = regionLabel(cc);
  const located = cc ? region : 'your current location';
  const reason = US_FAMILY.has(cc)
    ? 'Real-money skill competitions like Last Duck Standing are restricted under United States law. Because you appear to be in ' + region + ', we&rsquo;re not able to let you play or wager here.'
    : 'The laws that apply in ' + region + ' restrict real-money skill competitions, so &mdash; to stay compliant &mdash; we&rsquo;re not able to offer Last Duck Standing there right now.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Not available in ` + region + `</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%}
  body{
    display:flex;align-items:center;justify-content:center;min-height:100%;padding:24px;
    font-family:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    color:#eaf0ff;overflow:hidden;
    background:radial-gradient(1200px 600px at 50% -10%,#1c2b57 0%,transparent 60%),
               radial-gradient(900px 500px at 85% 110%,#3a1f5c 0%,transparent 55%),
               linear-gradient(160deg,#0a0f22 0%,#0b1128 55%,#0a0f1f 100%);
  }
  /* soft drifting glow blobs */
  .blob{position:fixed;border-radius:50%;filter:blur(70px);opacity:.35;z-index:0;pointer-events:none}
  .blob.a{width:340px;height:340px;left:-90px;top:-70px;background:#2b6fff;animation:float1 14s ease-in-out infinite}
  .blob.b{width:300px;height:300px;right:-80px;bottom:-70px;background:#a24bff;animation:float2 17s ease-in-out infinite}
  @keyframes float1{0%,100%{transform:translate(0,0)}50%{transform:translate(30px,26px)}}
  @keyframes float2{0%,100%{transform:translate(0,0)}50%{transform:translate(-26px,-30px)}}

  .card{
    position:relative;z-index:1;width:100%;max-width:460px;text-align:center;
    padding:44px 34px 34px;border-radius:24px;
    background:rgba(19,26,54,.72);
    border:1px solid rgba(130,160,255,.16);
    box-shadow:0 30px 80px -30px rgba(0,0,0,.7),inset 0 1px 0 rgba(255,255,255,.05);
    backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
    animation:rise .7s cubic-bezier(.2,.8,.2,1) both;
  }
  @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:translateY(0)}}

  .duck{font-size:76px;line-height:1;display:inline-block;filter:drop-shadow(0 10px 18px rgba(0,0,0,.45));animation:bob 3.2s ease-in-out infinite}
  @keyframes bob{0%,100%{transform:translateY(0) rotate(-3deg)}50%{transform:translateY(-10px) rotate(3deg)}}
  /* little water ripple under the duck */
  .ripple{width:120px;height:12px;margin:6px auto 0;border-radius:50%;
    background:radial-gradient(closest-side,rgba(120,160,255,.35),transparent);animation:squash 3.2s ease-in-out infinite}
  @keyframes squash{0%,100%{transform:scaleX(1);opacity:.6}50%{transform:scaleX(.7);opacity:.35}}

  .brand{font-size:12px;letter-spacing:.22em;text-transform:uppercase;color:#8fa6dd;font-weight:700;margin:18px 0 14px}
  h1{font-size:25px;line-height:1.25;margin:0 0 14px;font-weight:800;letter-spacing:-.01em}
  .loc{display:inline-flex;align-items:center;gap:7px;margin:0 0 16px;padding:7px 14px;border-radius:999px;
    font-size:12.5px;font-weight:600;color:#dfe7ff;background:rgba(255,255,255,.05);border:1px solid rgba(130,160,255,.18)}
  .loc b{font-weight:700;color:#fff}
  p{color:#a9b8e0;line-height:1.6;font-size:15.5px;margin:0 auto;max-width:380px}
  .pill{display:inline-flex;align-items:center;gap:8px;margin-top:22px;padding:9px 16px;border-radius:999px;
    font-size:12.5px;font-weight:600;color:#cdd8f5;background:rgba(120,150,255,.10);border:1px solid rgba(130,160,255,.20)}
  .dot{width:8px;height:8px;border-radius:50%;background:#ff5c7a;box-shadow:0 0 0 4px rgba(255,92,122,.18)}
  .foot{margin-top:26px;font-size:12px;color:#6f80ab}
</style></head>
<body>
  <div class="blob a"></div><div class="blob b"></div>
  <main class="card">
    <div class="duck">🦆</div><div class="ripple"></div>
    <div class="brand">Last Duck Standing</div>
    <h1>Not available in ` + region + `</h1>
    <div class="loc">📍 Detected location: <b>` + located + `</b></div>
    <p>` + reason + ` We&rsquo;re sorry to send you off &mdash; thanks for stopping by, and waddle back if the rules ever change.</p>
    <div class="pill"><span class="dot"></span> Restricted to comply with local law</div>
    <div class="foot">Location is estimated from your network. If you believe this is a mistake, please contact support.</div>
  </main>
</body></html>`;
}

// ===== Origin lockdown: force all real traffic through Cloudflare. =====
// Without this, someone who discovers the raw Render origin hostname can hit the app directly,
// which skips the Cloudflare edge geo rule AND arrives with no CF-IPCountry header (so the app-level
// geo check sees an empty country and lets it through) — a hole straight past both geo layers.
// A Cloudflare Transform Rule injects X-Origin-Secret on every proxied request; direct-to-origin
// hits won't have it, so we reject them. Off by default (ORIGIN_LOCK) so we can deploy the code,
// confirm Cloudflare is injecting the header, THEN flip enforcement on with no risk of self-lockout.
// /healthz (Render's internal health check, which does NOT go through Cloudflare) and the BTCPay
// webhook (from the BTCPay server, also not via Cloudflare) are always exempt.
const ORIGIN_LOCK = /^(1|true|on|yes)$/i.test(String(process.env.ORIGIN_LOCK || ''));
const ORIGIN_SECRET = process.env.ORIGIN_SECRET || '';
function originAllowed(req) {
  if (!ORIGIN_LOCK || !ORIGIN_SECRET) return true;
  const u = req.url || '';
  if (u === '/healthz' || u === '/api/btcpay/webhook') return true;
  return String(req.headers['x-origin-secret'] || '') === ORIGIN_SECRET;
}

const server = http.createServer((req, res) => {
  // Lightweight health check for Render (bypasses geo + origin lock so the platform never sees the app as down).
  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('ok');
    return;
  }
  // Reject any request that didn't come through Cloudflare (missing the injected secret header).
  if (!originAllowed(req)) {
    res.writeHead(403, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
    res.end('Forbidden');
    return;
  }
  // Owner bypass: hitting any URL with ?geo=SECRET remembers you via a 1-year cookie.
  if (GEO_BYPASS && (req.url || '').indexOf('geo=' + GEO_BYPASS) >= 0) {
    res.setHeader('Set-Cookie', 'geo=' + GEO_BYPASS + '; Max-Age=31536000; Path=/; SameSite=Lax');
  }
  // Geo-fence everything except the payment webhook (which comes from the BTCPay server, not a player).
  if (req.url !== '/api/btcpay/webhook' && geoBlocked(req)) {
    res.writeHead(451, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(geoBlockPage(req.headers['cf-ipcountry']));
    return;
  }
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
          let r; const au = req.url;
          if (au === '/api/admin/overview') r = adminOverview();
          else if (au === '/api/admin/metrics') r = await adminMetrics();
          else if (au === '/api/admin/health') r = { ok: true, health: serverHealth() };
          else if (au === '/api/admin/users') r = { ok: true, users: await store.listUsersFull(500) };
          else if (au === '/api/admin/search') r = await adminSearch(data.q);
          else if (au === '/api/admin/user') r = await adminUserProfile(data.username);
          else if (au === '/api/admin/transactions') r = { ok: true, tx: await store.listAllTx(data.limit || 80, data.kind || null) };
          else if (au === '/api/admin/revenue') r = { ok: true, series: await store.rpc('admin_revenue_series').catch(() => []) };
          else if (au === '/api/admin/tax') r = await adminTax();
          else if (au === '/api/admin/credits') { r = await adminAdjustCredits(data.username, data.delta); if (r && r.ok) adminAudit(data.token, 'credits', String(data.username || '').toLowerCase(), { delta: r.delta, reason: data.reason || '' }); }
          else if (au === '/api/admin/withdrawals') r = { ok: true, withdrawals: await store.listWithdrawals() };
          else if (au === '/api/admin/withdrawal') { r = await adminHandleWithdrawal(data.id, data.action); if (r && r.ok) adminAudit(data.token, 'withdrawal_' + data.action, String(data.id), null); }
          else if (au === '/api/admin/ban') r = await adminBan(data.token, data.username, data.reason);
          else if (au === '/api/admin/unban') r = await adminUnban(data.token, data.username);
          else if (au === '/api/admin/note') r = await adminSetNote(data.token, data.username, data.note);
          else if (au === '/api/admin/flag') r = await adminSetFlag(data.token, data.username, data.flagged);
          else if (au === '/api/admin/kick') r = await adminKick(data.token, data.username);
          else if (au === '/api/admin/void') r = await adminVoidGame(data.token, data.code);
          else if (au === '/api/admin/broadcast') r = adminBroadcast(data.token, data.text, data.level);
          else if (au === '/api/admin/settings') { await loadSettings(); r = { ok: true, settings: APP_SETTINGS }; }
          else if (au === '/api/admin/setting') r = await adminSetSetting(data.token, data.key, data.value);
          else if (au === '/api/admin/audit') r = { ok: true, audit: await store.listAudit(150) };
          else { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
          res.writeHead(r && r.error ? 400 : 200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(r)); return;
        }
        let result;
        if (req.url === '/api/register') result = await registerUser(data.username, data.password);
        else if (req.url === '/api/login') result = await loginUser(data.username, data.password);
        else if (req.url === '/api/deposit/create') result = await handleDepositCreate(data.token, data.amount);
        else if (req.url === '/api/deposit/details') result = await handleDepositDetails(data.token, data.invoice);
        else if (req.url === '/api/withdraw/create') result = await handleWithdrawCreate(data.token, data.amount, data.coin, data.address);
        else if (req.url === '/api/history') result = await handleHistory(data.token);
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
  // Live player counts: real (non-bot) connected players, how many are in the
  // matchmaking queue, and how many are in active matches. Used by the dashboard.
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/online') {
    let searching = 0, playing = 0, online = 0;
    for (const s of allSessions.values()) {
      if (!s.username) continue;                 // only authed humans
      online++;
      if (s.room) {
        if (s.room.phase === 'matchmaking') searching++;
        else playing++;                          // countdown / playing / roundover
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ searching, playing, online }));
    return;
  }
  // Live games anyone can watch: matches currently in countdown or play.
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/live') {
    const games = [];
    for (const r of rooms.values()) {
      if (r.phase === 'countdown' || r.phase === 'playing') {
        games.push({ code: r.code, phase: r.phase, players: r.members.size,
          alive: aliveList(r).length, wager: r.wager, pot: r.pot,
          roundTime: Math.floor(r.roundTime || 0), watchers: r.watchers ? r.watchers.size : 0 });
      }
    }
    games.sort((a, b) => b.alive - a.alive);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ games }));
    return;
  }
  // Static files: serve ONLY these from the project root. An explicit allowlist
  // means server code, .env, and other files can never be fetched over the web.
  const STATIC = new Set(['index.html', 'client.js', 'admin.html']);
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  let file = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  if (file === 'admin' || file === 'admin/') file = 'admin.html';   // pretty URL: /admin
  if (!STATIC.has(file)) { res.writeHead(404); res.end('Not found'); return; }
  // Maintenance mode: show a friendly closed page for the player-facing app (the /admin portal
  // and its client script stay reachable so the owner can still operate). Owner bypass = ?geo=SECRET.
  if (file === 'index.html' && maintenanceOn() && !geoBypassed(req)) {
    const note = (APP_SETTINGS['maintenance_message'] || 'We’re doing a quick tune-up. Back shortly!');
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '600' });
    res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Under maintenance — Last Duck Standing</title>' +
      '<style>html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;' +
      'background:radial-gradient(1000px 600px at 50% -10%,#1c2b57,transparent 60%),linear-gradient(160deg,#0a0f22,#0b1128 60%,#0a0f1f);' +
      'color:#eaf0ff;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}.b{max-width:440px;text-align:center;padding:34px}' +
      '.d{font-size:70px}h1{font-size:23px;margin:14px 0 10px}p{color:#a9b8e0;line-height:1.6;font-size:15px}</style>' +
      '<div class="b"><div class="d">🛠️🦆</div><h1>We’ll be right back</h1><p>' +
      String(note).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])) + '</p></div>');
    return;
  }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// =================== Game constants ===================
const WORLD = { w: 960, h: 600 };
const TICK_MS = 1000 / 60;           // 60 ticks/sec; physics is tuned per-tick
const BROADCAST_EVERY = 1;           // send a snapshot every tick (60/sec) — client interpolates

const PW = 28, PH = 28;
const GRAVITY = 0.72, MOVE_ACCEL = 0.95, MOVE_MAX = 5.6, FRICTION = 0.80;
const JUMP_V = -15.2, MAX_FALL = 17;

// Matchmaking
const MATCH_SIZE = 8;                                       // target players per match
const MATCH_WAIT_S = Number(process.env.MATCH_WAIT_S || 10); // base fill window before bots backfill
const JOIN_EXTEND_S = 6;    // each time a human joins a waiting lobby, keep it open a few more seconds
const MATCH_WAIT_MAX = 25;  // ...but never make anyone wait longer than this since the lobby opened
const LOBBY_S = 30;         // post-match ready-up window (practice)
const LOBBY_CASH_HOLD = 15; // cash: hold for real players, then backfill bots and start
const COUNTDOWN_S = 3, ROUNDOVER_S = 6;

// Climb-or-die scroll: the whole field slides DOWN and speeds up over time.
const SCROLL_START = 31;    // px/sec at the start of a round — quicker off the line
const SCROLL_RAMP = 2.5;    // added px/sec each second — climbs to top speed sooner
const SCROLL_MAX = 128;     // hardest steady speed (still climbable; deaths come from misses/balls)
const PLAT_H = 16;
const GAP_MIN = 84, GAP_MAX = 116;   // wider vertical spacing — still reachable by a jump, less margin
const SPREAD = 114;                  // max horizontal shift between rungs — always within a jump's reach

// Hazards — telegraphed, readable bouncing balls. Every ball warns before it drops and follows
// deterministic physics, so a skilled player can ALWAYS dodge it. Hard, but never luck.
const HAZARD_R = 15, HAZARD_GRAV = 0.5, HAZARD_BOUNCE = -12.5;
const HAZARD_FIRST = 10, HAZARD_MAX = 6;           // balls arrive sooner and pile up thicker late
const HAZARD_WARN = 0.65;                           // shorter telegraph — you must read & react faster (still always dodgeable)
const KNOCK_VY = -8.5, KNOCK_SHOVE = 18, KNOCK_INVULN = 0.5;

const COLORS = ['#ff5252', '#ffb142', '#fff35c', '#32ff7e', '#18dcff',
                '#7d5fff', '#ff4d97', '#5ad1cd', '#ff9f43', '#badc58'];
// Varied, human-looking usernames (social-media handle style) for AI opponents.
const NAME_A = ['shadow','ghost','ninja','duck','frost','pixel','turbo','crimson','neo','viper',
  'lunar','byte','storm','ace','rogue','zen','echo','blitz','nova','riot','sly','mako','drift',
  'booty','goose','quack','savage','vortex','onyx','rapid','hydro','cyber','mystic','flux','toxic',
  'grim','jelly','waffle','mango','goblin','phantom','static','ember','shark','wolf','raven'];
const NAME_B = ['man','gamer','king','lord','wolf','fox','beast','slayer','master','hunter','ryder',
  'kid','boss','star','wizard','gremlin','goblin','sniper','legend','vibes','czar','punk','duck',
  'god','ghost','mania','face','head','tron','zilla','bandit','ninja','pro'];
function randomUsername() {
  const r = Math.random();
  const a = NAME_A[Math.floor(Math.random() * NAME_A.length)];
  const b = NAME_B[Math.floor(Math.random() * NAME_B.length)];
  const nums = ['', '', String(Math.floor(Math.random() * 99)),
                String(Math.floor(Math.random() * 9000) + 1000),
                '3000', '420', '69', '777', '99', '007'];
  const num = nums[Math.floor(Math.random() * nums.length)];
  if (r < 0.32) return a + b + num;
  if (r < 0.55) return a + '_' + b + num;
  if (r < 0.72) return (Math.random() < 0.5 ? 'xX' : '') + a + b + (Math.random() < 0.5 ? 'Xx' : num);
  if (r < 0.86) return a + '.' + b;
  return a + num + b;
}
// Bots keep themselves in the visible frame — they won't leap above this line (looks human).
const TOP_SAFE = 72;

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
    fillTimer: MATCH_WAIT_S, waited: 0, phaseTimer: 0,
    roundTime: 0, winnerName: null, scrollSpeed: SCROLL_START,
    platforms: [], nextPlatId: 0, lastCenterX: WORLD.w / 2, tick: 0, eliminated: 0,
    hazards: [], nextHazardAt: HAZARD_FIRST,
    watchers: new Set(),                  // sessions watching this match for fun (not players)
  };
  rooms.set(code, room);
  return room;
}

function addToMatch(s, wager) {
  if (s.room) leaveMatch(s, true);
  let room = [...rooms.values()].find(r => r.phase === 'matchmaking' && r.wager === wager && humanCount(r) < MATCH_SIZE);
  if (!room) room = createRoom(wager);
  s.room = room; s.player = newPlayer(); s.ready = true;   // matchmaking players are auto-ready (they paid on join)
  room.members.set(s.id, s);
  // Momentum-based fill window: each human who joins keeps the lobby open a little longer
  // so real players keep gathering instead of the timer expiring into a bot-heavy match —
  // but never past MATCH_WAIT_MAX since the lobby opened. Full lobbies (8) still start instantly.
  if (humanCount(room) < MATCH_SIZE) {
    const roomLeft = MATCH_WAIT_MAX - room.waited;
    if (roomLeft > 0) room.fillTimer = Math.max(room.fillTimer, Math.min(JOIN_EXTEND_S, roomLeft));
  }
  sendSearch(room);
  return room;
}
function leaveMatch(s, silent) {
  const room = s.room;
  if (!room) return;
  // Refund the escrowed wager only if the match has NOT started (still matchmaking).
  // Leaving once it's started forfeits the stake (it stays in the pot).
  if (s.wagerPaid > 0 && (room.phase === 'matchmaking' || room.phase === 'lobby')) {
    const k = s.key;
    changeCredits(k, s.wagerPaid).then(nc => { if (s.key === k) { s.credits = nc; } reflectCredits(k, nc); }).catch(() => {});
  }
  s.wagerPaid = 0; s.ready = false;
  room.members.delete(s.id);
  s.room = null; s.player = null;
  if (humanCount(room) === 0) { killRoom(room); }      // no humans -> drop match (and its bots)
  else if (room.phase === 'matchmaking') sendSearch(room);
  else if (room.phase === 'lobby') broadcastLobby(room);
  if (!silent) try { s.conn.send(JSON.stringify({ t: 'home' })); } catch (e) {}
}

// ---- bots ----
function uniqueBotName(room) {
  const taken = new Set([...room.members.values()].map(m => m.username.toLowerCase()));
  let name = randomUsername(), guard = 0;
  while (taken.has(name.toLowerCase()) && guard++ < 40) name = randomUsername();
  while (taken.has(name.toLowerCase())) name += Math.floor(Math.random() * 99);
  return name;
}
function makeBot(room) {
  const bot = {
    id: nextSessionId++, isBot: true, username: uniqueBotName(room),
    conn: { send() {} }, room, player: newPlayer(),
    ai: { skill: 0.82 + Math.random() * 0.14, jitter: (Math.random() - 0.5) * 7, aim: 12 + Math.random() * 20,
          react: 2 + Math.floor(Math.random() * 7), reactT: 0, elite: false, retargetIn: 0, target: null },
  };
  room.members.set(bot.id, bot);
  return bot;
}
function fillWithBots(room) {
  while (room.members.size < MATCH_SIZE) makeBot(room);
  // Make up to 2 opponents genuinely elite: near-flawless dodging, precise landings, fast reactions.
  const bots = [...room.members.values()].filter(m => m.isBot);
  const shuffled = bots.slice().sort(() => Math.random() - 0.5);
  for (let i = 0; i < Math.min(2, shuffled.length); i++) {
    const a = shuffled[i].ai;
    a.elite = true;
    a.skill = 1;
    a.jitter = (Math.random() - 0.5) * 2;   // near-perfect, but not robotically pixel-exact
    a.aim = 7 + Math.random() * 4;
    a.react = 1 + Math.floor(Math.random() * 2);
  }
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
  const w = width != null ? width : 78 + Math.floor(Math.random() * 62);   // narrower still — precise landings required
  const x = reachableX(room, w);
  const p = { id: room.nextPlatId++, x, y, w, h: PLAT_H, vx: 0, dx: 0 };
  if (moving) { p.homeX = x; p.amp = 30 + Math.random() * 34; p.phase = Math.random() * 6.283; p.spd = 0.028 + Math.random() * 0.030; }   // faster, wider drift
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
    const moving = idx >= 2 && Math.random() < 0.72;   // movers kick in earlier and dominate — more timing pressure
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
let hazSeq = 0;
function spawnHazard(room) {
  room.hazards.push({
    id: hazSeq++,
    x: HAZARD_R + Math.random() * (WORLD.w - 2 * HAZARD_R),
    y: -HAZARD_R - 10,
    vx: (2.6 + Math.random() * 3.0) * (Math.random() < 0.5 ? -1 : 1),   // faster, fixed per ball — readable but tighter to dodge
    vy: 0, r: HAZARD_R,
    warn: HAZARD_WARN,                                                // telegraph before it drops
  });
}
function resetHazard(b) {
  b.x = HAZARD_R + Math.random() * (WORLD.w - 2 * HAZARD_R);
  b.y = -HAZARD_R - 10; b.vx = (2.6 + Math.random() * 3.0) * (Math.random() < 0.5 ? -1 : 1); b.vy = 0;
  b.warn = HAZARD_WARN;
}
// Calm opening, hectic late: balls only appear after HAZARD_FIRST, then get faster and
// more numerous the longer the round runs and the more players are eliminated.
function hazardFactor(room) {
  const t = Math.max(0, room.roundTime - HAZARD_FIRST);
  return 1 + Math.min(1.7, t * 0.018 + room.eliminated * 0.07);
}
function targetHazards(room) {
  if (room.roundTime < HAZARD_FIRST) return 0;
  return Math.min(HAZARD_MAX, 1 + Math.floor((room.roundTime - HAZARD_FIRST) / 12) + Math.floor(room.eliminated / 4));
}
function stepHazards(room) {
  const scrollPx = room.scrollSpeed / 60;
  const hf = hazardFactor(room);
  for (const b of room.hazards) {
    if (b.warn > 0) { b.warn -= 1 / 60; b.y = -HAZARD_R - 10; continue; }   // telegraphing — parked above, not lethal yet
    b.vy += HAZARD_GRAV * hf;
    b.x += b.vx * hf;
    b.y += b.vy + scrollPx;
    if (b.x < b.r) { b.x = b.r; b.vx = Math.abs(b.vx); }                    // clean reflection — fully readable
    if (b.x > WORLD.w - b.r) { b.x = WORLD.w - b.r; b.vx = -Math.abs(b.vx); }
    if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy) * 0.6; }
    if (b.vy > 0) {
      for (const plat of room.platforms) {
        if (b.x + b.r > plat.x && b.x - b.r < plat.x + plat.w &&
            b.y + b.r >= plat.y && b.y + b.r <= plat.y + plat.h + 14) {
          b.y = plat.y - b.r;
          b.vy = HAZARD_BOUNCE * hf;                        // deterministic bounce — predictable arc, dodgeable
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
  const ai = bot.ai;
  if (!p.alive || p.spectator) { p.input.left = p.input.right = p.input.jump = false; return; }
  const feet = p.y + PH, cx = p.x + PW / 2;

  const onGround = p.onPlatform != null;
  let best = ai.target != null ? room.platforms.find(pl => pl.id === ai.target) : null;
  if (best && best.y >= feet - 2) best = null;
  if (onGround || !best) {
    best = null; let bestScore = Infinity, nearest = null, nearGap = Infinity;
    for (const plat of room.platforms) {
      if (plat.y >= feet - 4) continue;              // must be above us
      if (plat.y < p.y - 168) continue;              // within a single jump's reach
      if (plat.y < TOP_SAFE) continue;               // stay on-screen — never leap above the frame
      const gap = Math.abs((plat.x + plat.w / 2) - cx);
      if (gap < nearGap) { nearGap = gap; nearest = plat; }
      if (gap > 230) continue;
      const score = gap + (feet - plat.y) * 0.2;
      if (score < bestScore) { bestScore = score; best = plat; }
    }
    if (!best) best = nearest;
    if (!best) { let hi = Infinity; for (const plat of room.platforms) if (plat.y < hi && plat.y < feet && plat.y >= TOP_SAFE) { hi = plat.y; best = plat; } }
    if (best) ai.target = best.id;
  }

  // Hazard evasion — skilled bots see the ball coming earlier and from farther away.
  let evade = 0, danger = false;
  const reach = 76 + ai.skill * 48;
  for (const b of room.hazards) {
    const bx = cx - b.x, by = (feet - PH / 2) - b.y;
    if (bx * bx + by * by < (b.r + reach) * (b.r + reach)) { evade = bx >= 0 ? 1 : -1; danger = true; break; }
  }

  let goX = best ? (best.x + best.w / 2) : cx;
  if (evade) goX = cx + evade * 150;
  goX += ai.jitter;
  const d = goX - cx;
  p.input.left = d < -3;
  p.input.right = d > 3;

  let wantJump = false;
  if (onGround) {
    const plat = room.platforms.find(pl => pl.id === p.onPlatform);
    if (best && best.y < feet - 6 && best.y >= TOP_SAFE) {
      const tcx = best.x + best.w / 2;
      if (Math.abs(tcx - cx) < best.w / 2 + ai.aim) wantJump = true;
      else if (plat) {
        if (tcx > cx && cx > plat.x + plat.w - 26) wantJump = true;
        if (tcx < cx && cx < plat.x + 26) wantJump = true;
      }
    }
    if (feet > WORLD.h - 58) wantJump = true;         // forced: the rising floor is here
    if (danger && feet > 150) wantJump = true;        // dodge an incoming ball
  }

  // Per-bot reaction delay so they don't all jump on the exact same tick (that was the obvious tell).
  if (wantJump) {
    if (ai.reactT <= 0) ai.reactT = ai.react;
    ai.reactT--;
    p.input.jump = (ai.reactT <= 0) && !p.jumpHeld;
  } else {
    ai.reactT = 0;
    p.input.jump = false;
  }
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

// ---- Post-match ready-up lobby ----
function lobbyMembers(room) {
  return [...room.members.values()].filter(s => !s.isBot).map(s => ({ name: s.username, ready: !!s.ready }));
}
function broadcastLobby(room) {
  const deadline = room.wager > 0 ? LOBBY_CASH_HOLD : LOBBY_S;
  const base = { t: 'lobby', wager: room.wager, secs: Math.max(0, Math.ceil(deadline - (room.lobbyTimer || 0))),
                 members: lobbyMembers(room), total: humanCount(room) };
  for (const s of room.members.values()) {
    if (s.isBot) continue;
    const msg = Object.assign({}, base, { credits: s.credits, youReady: !!s.ready });
    if (s.wonStats) { msg.won = true; msg.payout = s.wonStats.payout; msg.wins = s.wonStats.wins; msg.rank = s.wonStats.rank; s.wonStats = null; }
    try { s.conn.send(JSON.stringify(msg)); } catch (e) {}
  }
}
function enterLobby(room) {
  endWatchers(room);                                   // the live game is over
  for (const [id, m] of [...room.members]) if (m.isBot) room.members.delete(id);   // drop bots
  if (humanCount(room) === 0) { killRoom(room); return; }
  room.phase = 'lobby'; room.lobbyTimer = 0; room.pot = 0; room.winnerName = null;
  room.hazards = []; room.platforms = [];
  for (const s of room.members.values()) { s.ready = false; s.wagerPaid = 0; s.player = newPlayer(); }
  broadcastLobby(room);
}
function kickNonReady(room) {
  for (const [id, s] of [...room.members]) {
    if (s.isBot || s.ready) continue;
    room.members.delete(id); s.room = null; s.player = null;   // never charged this round -> no refund
    try { s.conn.send(JSON.stringify({ t: 'home', credits: s.credits })); } catch (e) {}
  }
}
function startFromLobby(room) {
  kickNonReady(room);
  if (humanCount(room) === 0) { killRoom(room); return; }
  for (const s of room.members.values()) s.ready = false;      // reset for the next lobby
  startMatch(room);                                            // fills bots, sets pot from paid wagers, counts down
}
function updateRoom(room, dt) {
  if (room.phase === 'matchmaking') {
    if (humanCount(room) === 0) { killRoom(room); return; }
    room.waited += dt;
    room.fillTimer -= dt;
    if (room.members.size >= MATCH_SIZE || room.fillTimer <= 0) startMatch(room);
    return;
  }
  if (humanCount(room) === 0) { killRoom(room); return; }

  if (room.phase === 'countdown') {
    room.phaseTimer -= dt;
    if (room.phaseTimer <= 0) { room.phase = 'playing'; room.roundTime = 0; }
  } else if (room.phase === 'playing') {
    room.roundTime += dt;
    let ss = Math.min(SCROLL_MAX, SCROLL_START + room.roundTime * SCROLL_RAMP);
    // Speed climbs a bit more from 80s, then LOCKS at the 90s pace and holds forever —
    // from there it's pure survival, not an ever-faster wall.
    if (room.roundTime > 80) ss = SCROLL_MAX + (Math.min(room.roundTime, 90) - 80) * 11;
    room.scrollSpeed = ss;
    if (room.roundTime >= room.nextHazardAt && room.hazards.length < targetHazards(room)) {
      spawnHazard(room);
      const ramp = Math.max(0, room.roundTime - HAZARD_FIRST);
      room.nextHazardAt = room.roundTime + Math.max(1.5, 7.0 - room.eliminated * 0.4 - ramp * 0.07);
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
    if (room.phaseTimer <= 0) enterLobby(room);          // stay together in a ready-up lobby
  } else if (room.phase === 'lobby') {
    room.lobbyTimer += dt;
    const humans = [...room.members.values()].filter(x => !x.isBot);
    if (humans.length === 0) { killRoom(room); return; }
    const readyN = humans.filter(x => x.ready).length;
    const allReady = readyN === humans.length;
    const deadline = room.wager > 0 ? LOBBY_CASH_HOLD : LOBBY_S;
    if (readyN >= MATCH_SIZE) { startFromLobby(room); return; }              // full house of ready players
    if (allReady && readyN >= (room.wager > 0 ? 2 : 1) && room.lobbyTimer > 2) { startFromLobby(room); return; }
    if (room.lobbyTimer >= deadline) {                                       // window up: drop idlers, then go
      kickNonReady(room);
      if (humanCount(room) >= 1) startFromLobby(room); else killRoom(room);
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
    t: 'snapshot', code: room.code, phase: room.phase, st: Date.now(),
    countdown: Math.max(0, Math.ceil(room.phaseTimer)),
    roundTime: Math.floor(room.roundTime), winner: room.winnerName,
    alive: aliveList(room).length, total: room.members.size,
    wager: room.wager, pot: room.pot,
    scroll: Math.round(room.scrollSpeed),
    platforms: room.platforms.map(p => ({ id: p.id, x: Math.round(p.x), y: Math.round(p.y), w: p.w, h: p.h })),
    hazards: room.hazards.map(b => ({ id: b.id, x: Math.round(b.x), y: Math.round(b.y), r: b.r, w: b.warn > 0 ? 1 : 0 })),
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
  if (room.watchers && room.watchers.size) for (const w of room.watchers) { try { w.conn.send(msg); } catch (e) {} }
}
// Tell anyone watching this match that it's over, then detach them.
function endWatchers(room) {
  if (!room.watchers) return;
  for (const w of room.watchers) { w.watching = null; try { w.conn.send(JSON.stringify({ t: 'specEnd' })); } catch (e) {} }
  room.watchers.clear();
}
function killRoom(room) { endWatchers(room); rooms.delete(room.code); }
// Detach a session from whatever match it's watching.
function stopWatching(s) {
  if (!s || !s.watching) return;
  const r = rooms.get(s.watching);
  if (r && r.watchers) r.watchers.delete(s);
  s.watching = null;
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
    } else if (room.phase === 'lobby') {
      if (room.tick % 30 === 0) broadcastLobby(room);
    } else if (room.tick % BROADCAST_EVERY === 0) {
      broadcastRoom(room);
    }
  }
}, TICK_MS);

// =================== Connections ===================
ws.attach(server, (conn) => {
  const s = { id: nextSessionId++, conn, username: null, key: null, room: null, player: null, isBot: false, ready: false };
  allSessions.set(s.id, s);

  conn.on('message', async (raw) => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'auth') {
      const key = sessionKey(m.token);
      if (!key) { conn.send(JSON.stringify({ t: 'authfail' })); return; }
      store.getUser(key).then((u) => {
        if (!u) { conn.send(JSON.stringify({ t: 'authfail' })); return; }
        if (u.banned && key !== ADMIN_USER) { conn.send(JSON.stringify({ t: 'banned', reason: u.banned_reason || '' })); return; }
        if (maintenanceOn() && key !== ADMIN_USER) { conn.send(JSON.stringify({ t: 'maintenance', message: APP_SETTINGS['maintenance_message'] || 'The site is temporarily under maintenance.' })); return; }
        s.username = u.username; s.key = key; s.credits = u.credits;
        conn.send(JSON.stringify({ t: 'authed', username: u.username, credits: u.credits, wins: u.wins || 0, rank: rankFor(u.wins || 0) }));
        if (settingBool('announcement_active') && APP_SETTINGS['announcement']) {
          try { conn.send(JSON.stringify({ t: 'sysbanner', text: APP_SETTINGS['announcement'], level: APP_SETTINGS['announcement_level'] || 'info' })); } catch (e) {}
        }
      }).catch((e) => {
        console.error('auth lookup failed:', e.message);
        conn.send(JSON.stringify({ t: 'authfail' }));
      });
      return;
    }
    if (!s.username) return; // everything below requires auth

    if (m.t === 'findMatch') {
      if (maintenanceOn() && s.key !== ADMIN_USER) { try { conn.send(JSON.stringify({ t: 'matchError', error: 'Matchmaking is paused for maintenance. Please check back soon.' })); } catch (e) {} return; }
      if (s.room) leaveMatch(s, true);                 // leave (and refund) any current queue first
      const wager = [5, 10, 50, 100].indexOf(Number(m.wager)) >= 0 ? Number(m.wager) : 0;
      // Prefer joining an existing ready-up lobby of the same wager — you pay on READY, not on join.
      const lob = [...rooms.values()].find(r => r.phase === 'lobby' && r.wager === wager && humanCount(r) < MATCH_SIZE);
      if (lob) {
        s.wagerPaid = 0; s.ready = false; s.room = lob; s.player = newPlayer();
        lob.members.set(s.id, s);
        broadcastLobby(lob);
        return;
      }
      if (wager > 0) {
        const deb = await debitIfEnough(s.key, wager); // escrow the stake on join (atomic)
        if (!deb.ok) { try { conn.send(JSON.stringify({ t: 'matchError', error: 'Not enough credits for that entry fee.' })); } catch (e) {} return; }
        s.credits = deb.credits; s.wagerPaid = wager;
        try { conn.send(JSON.stringify({ t: 'credits', credits: deb.credits })); } catch (e) {}
      } else { s.wagerPaid = 0; }
      addToMatch(s, wager);
    } else if (m.t === 'ready') {
      // Ready up for the next match. In a cash lobby this charges the entry fee now.
      const room = s.room;
      if (!room || room.phase !== 'lobby' || s.ready) return;
      if (room.wager > 0) {
        const deb = await debitIfEnough(s.key, room.wager);
        if (!deb.ok) { try { conn.send(JSON.stringify({ t: 'lobbyError', error: 'Not enough credits to ready up.' })); } catch (e) {} return; }
        s.credits = deb.credits; s.wagerPaid = room.wager;
        try { conn.send(JSON.stringify({ t: 'credits', credits: deb.credits })); } catch (e) {}
      }
      s.ready = true;
      broadcastLobby(room);
    } else if (m.t === 'leaveLobby') {
      leaveMatch(s, false);                            // refunds if you'd readied (match hasn't started)
    } else if (m.t === 'spectate') {
      // Watch a live game for fun — read-only, never joins as a player.
      stopWatching(s);
      if (s.room) return;                                  // can't watch while in your own match
      const r = rooms.get(String(m.code || '').toUpperCase());
      if (!r || (r.phase !== 'playing' && r.phase !== 'countdown')) { try { conn.send(JSON.stringify({ t: 'specEnd' })); } catch (e) {} return; }
      r.watchers.add(s); s.watching = r.code;
      try { conn.send(roomSnapshot(r)); } catch (e) {}
    } else if (m.t === 'stopSpectate') {
      stopWatching(s);
      try { conn.send(JSON.stringify({ t: 'home', credits: s.credits })); } catch (e) {}
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
    stopWatching(s);
    leaveMatch(s, true);
    allSessions.delete(s.id);
  });
}, geoBlocked);   // gate: refuse WebSocket upgrades from geo-blocked regions

server.listen(PORT, () => {
  console.log('Last Duck Standing running at  http://localhost:' + PORT);
  console.log('Accounts storage: ' + (store.backend === 'supabase' ? 'Supabase (Postgres)' : 'local file (data/users.json)'));
  console.log('Sign in, hit Find Match — bots fill any empty slots so a game always starts.');
});

// Exported for the automated tests.
module.exports = { server };
