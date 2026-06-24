// Storage layer for accounts + credits.
// If SUPABASE_URL and SUPABASE_SERVICE_KEY are set, it talks to your Supabase
// Postgres database over its REST API (PostgREST) using the built-in fetch — no
// extra npm packages needed. Otherwise it falls back to a local JSON file so the
// game still runs out of the box.
//
// User record shape (same for both backends):
//   { username, username_lower, salt, hash, credits, wins, created_at }
const fs = require('fs');
const path = require('path');

const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TABLE = process.env.SUPABASE_TABLE || 'game_users';
const useSupabase = !!(SB_URL && SB_KEY);

// ---------------- Supabase (PostgREST) backend ----------------
function sbHeaders(extra) {
  return Object.assign({
    apikey: SB_KEY,
    Authorization: 'Bearer ' + SB_KEY,
    'Content-Type': 'application/json',
  }, extra || {});
}
async function sbGetUser(key) {
  const url = SB_URL + '/rest/v1/' + TABLE + '?username_lower=eq.' + encodeURIComponent(key) + '&select=*&limit=1';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase getUser ' + r.status + ': ' + (await r.text()));
  const rows = await r.json();
  return rows[0] || null;
}
async function sbCreateUser(u) {
  const r = await fetch(SB_URL + '/rest/v1/' + TABLE, {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(u),
  });
  if (r.status === 409) throw new Error('DUPLICATE');
  if (!r.ok) throw new Error('Supabase createUser ' + r.status + ': ' + (await r.text()));
}
async function sbUpdateCredits(key, credits) {
  const url = SB_URL + '/rest/v1/' + TABLE + '?username_lower=eq.' + encodeURIComponent(key);
  const r = await fetch(url, {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ credits }),
  });
  if (!r.ok) throw new Error('Supabase updateCredits ' + r.status + ': ' + (await r.text()));
}

async function sbRecordWin(key) {
  const u = await sbGetUser(key);
  const wins = ((u && u.wins) || 0) + 1;
  const r = await fetch(SB_URL + '/rest/v1/' + TABLE + '?username_lower=eq.' + encodeURIComponent(key), {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ wins }),
  });
  if (!r.ok) throw new Error('Supabase recordWin ' + r.status + ': ' + (await r.text()));
  return wins;
}
async function sbCreateWithdrawal(key, amount) {
  const r = await fetch(SB_URL + '/rest/v1/withdrawal_requests', {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ username_lower: key, amount: amount }),
  });
  if (!r.ok) throw new Error('Supabase createWithdrawal ' + r.status + ': ' + (await r.text()));
}
// ---- admin helpers (Supabase) ----
async function sbListUsers() {
  const url = SB_URL + '/rest/v1/' + TABLE + '?select=username,username_lower,credits,wins,created_at&order=credits.desc';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listUsers ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbListWithdrawals() {
  const url = SB_URL + '/rest/v1/withdrawal_requests?select=*&order=created_at.desc';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listWithdrawals ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbSetWithdrawalStatus(id, status) {
  const url = SB_URL + '/rest/v1/withdrawal_requests?id=eq.' + encodeURIComponent(id);
  const r = await fetch(url, {
    method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify({ status: status }),
  });
  if (!r.ok) throw new Error('Supabase setWithdrawalStatus ' + r.status + ': ' + (await r.text()));
}

// ---- transactions (Supabase) ----
async function sbTxExists(kind, ref) {
  const url = SB_URL + '/rest/v1/game_transactions?kind=eq.' + encodeURIComponent(kind) + '&room_code=eq.' + encodeURIComponent(ref) + '&select=id&limit=1';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase txExists ' + r.status + ': ' + (await r.text()));
  const rows = await r.json();
  return rows.length > 0;
}
async function sbAddTx(t) {
  const r = await fetch(SB_URL + '/rest/v1/game_transactions', {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }),
    body: JSON.stringify({ username_lower: t.username_lower, kind: t.kind, amount: t.amount, room_code: t.room_code || null }),
  });
  if (!r.ok) throw new Error('Supabase addTx ' + r.status + ': ' + (await r.text()));
}
async function sbGetTx(kind, ref) {
  const url = SB_URL + '/rest/v1/game_transactions?kind=eq.' + encodeURIComponent(kind) + '&room_code=eq.' + encodeURIComponent(ref) + '&select=*&limit=1';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase getTx ' + r.status + ': ' + (await r.text()));
  const rows = await r.json();
  return rows[0] || null;
}
async function sbListTxByUser(key) {
  const url = SB_URL + '/rest/v1/game_transactions?username_lower=eq.' + encodeURIComponent(key) + '&select=*&order=created_at.desc&limit=200';
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listTxByUser ' + r.status + ': ' + (await r.text()));
  return await r.json();
}

// ---------------- Local file backend ----------------
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = {};
try { users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); } catch (e) { users = {}; }
function saveUsers() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2)); }
  catch (e) { console.error('saveUsers failed', e); }
}
async function fileGetUser(key) { return users[key] || null; }
async function fileCreateUser(u) {
  if (users[u.username_lower]) throw new Error('DUPLICATE');
  users[u.username_lower] = u; saveUsers();
}
async function fileUpdateCredits(key, credits) {
  if (users[key]) { users[key].credits = credits; saveUsers(); }
}
async function fileRecordWin(key) {
  if (users[key]) { users[key].wins = (users[key].wins || 0) + 1; saveUsers(); return users[key].wins; }
  return 0;
}
const WITHDRAW_FILE = path.join(DATA_DIR, 'withdrawals.json');
let withdrawals = [];
try { withdrawals = JSON.parse(fs.readFileSync(WITHDRAW_FILE, 'utf8')); } catch (e) { withdrawals = []; }
function saveWithdrawals() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WITHDRAW_FILE, JSON.stringify(withdrawals, null, 2)); } catch (e) {}
}
async function fileCreateWithdrawal(key, amount) {
  withdrawals.push({ id: withdrawals.length, username_lower: key, amount: amount, status: 'pending', created_at: new Date().toISOString() });
  saveWithdrawals();
}
// ---- admin helpers (file) ----
async function fileListUsers() {
  return Object.values(users).map(u => ({
    username: u.username, username_lower: u.username_lower,
    credits: u.credits, wins: u.wins || 0, created_at: u.created_at,
  })).sort((a, b) => (b.credits || 0) - (a.credits || 0));
}
async function fileListWithdrawals() {
  return withdrawals.map((w, i) => Object.assign({ id: (w.id != null ? w.id : i) }, w))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}
async function fileSetWithdrawalStatus(id, status) {
  const row = withdrawals.find((w, i) => String(w.id != null ? w.id : i) === String(id));
  if (row) { row.status = status; saveWithdrawals(); }
}
// ---- transactions (file) ----
const TX_FILE = path.join(DATA_DIR, 'transactions.json');
let txs = [];
try { txs = JSON.parse(fs.readFileSync(TX_FILE, 'utf8')); } catch (e) { txs = []; }
async function fileTxExists(kind, ref) {
  return txs.some(t => t.kind === kind && String(t.room_code) === String(ref));
}
async function fileAddTx(t) {
  txs.push({ username_lower: t.username_lower, kind: t.kind, amount: t.amount, room_code: t.room_code || null, created_at: new Date().toISOString() });
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(TX_FILE, JSON.stringify(txs, null, 2)); } catch (e) {}
}
async function fileGetTx(kind, ref) {
  return txs.find(t => t.kind === kind && String(t.room_code) === String(ref)) || null;
}
async function fileListTxByUser(key) {
  return txs.filter(t => t.username_lower === key).slice().reverse();
}

module.exports = useSupabase
  ? { backend: 'supabase', getUser: sbGetUser, createUser: sbCreateUser, updateCredits: sbUpdateCredits,
      recordWin: sbRecordWin, createWithdrawal: sbCreateWithdrawal,
      listUsers: sbListUsers, listWithdrawals: sbListWithdrawals, setWithdrawalStatus: sbSetWithdrawalStatus,
      txExists: sbTxExists, addTx: sbAddTx, getTx: sbGetTx, listTxByUser: sbListTxByUser }
  : { backend: 'file', getUser: fileGetUser, createUser: fileCreateUser, updateCredits: fileUpdateCredits,
      recordWin: fileRecordWin, createWithdrawal: fileCreateWithdrawal,
      listUsers: fileListUsers, listWithdrawals: fileListWithdrawals, setWithdrawalStatus: fileSetWithdrawalStatus,
      txExists: fileTxExists, addTx: fileAddTx, getTx: fileGetTx, listTxByUser: fileListTxByUser };
