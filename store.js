// Storage layer for accounts + credits.
// If SUPABASE_URL and SUPABASE_SERVICE_KEY are set, it talks to your Supabase
// Postgres database over its REST API (PostgREST) using the built-in fetch — no
// extra npm packages needed. Otherwise it falls back to a local JSON file so the
// game still runs out of the box.
//
// User record shape (same for both backends):
//   { username, username_lower, salt, hash, credits, created_at }
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
  const url = `${SB_URL}/rest/v1/${TABLE}?username_lower=eq.${encodeURIComponent(key)}&select=*&limit=1`;
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase getUser ' + r.status + ': ' + (await r.text()));
  const rows = await r.json();
  return rows[0] || null;
}
async function sbCreateUser(u) {
  const r = await fetch(`${SB_URL}/rest/v1/${TABLE}`, {
    method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(u),
  });
  if (r.status === 409) throw new Error('DUPLICATE');
  if (!r.ok) throw new Error('Supabase createUser ' + r.status + ': ' + (await r.text()));
}
async function sbUpdateCredits(key, credits) {
  const url = `${SB_URL}/rest/v1/${TABLE}?username_lower=eq.${encodeURIComponent(key)}`;
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
async function fileCreateWithdrawal(key, amount) {
  withdrawals.push({ username_lower: key, amount: amount, status: 'pending', created_at: new Date().toISOString() });
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WITHDRAW_FILE, JSON.stringify(withdrawals, null, 2)); } catch (e) {}
}

module.exports = useSupabase
  ? { backend: 'supabase', getUser: sbGetUser, createUser: sbCreateUser, updateCredits: sbUpdateCredits, recordWin: sbRecordWin, createWithdrawal: sbCreateWithdrawal }
  : { backend: 'file', getUser: fileGetUser, createUser: fileCreateUser, updateCredits: fileUpdateCredits, recordWin: fileRecordWin, createWithdrawal: fileCreateWithdrawal };
