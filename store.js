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

// ================= Admin suite data layer =================
const USER_FULL_COLS = 'username,username_lower,credits,wins,created_at,banned,banned_reason,banned_at,admin_note,flagged,last_seen';
// ---- Supabase ----
async function sbListUsersFull(limit) {
  const url = SB_URL + '/rest/v1/' + TABLE + '?select=' + USER_FULL_COLS + '&order=credits.desc&limit=' + (limit || 500);
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listUsersFull ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbSearchUsers(q, limit) {
  const enc = encodeURIComponent('*' + String(q).toLowerCase() + '*');
  const url = SB_URL + '/rest/v1/' + TABLE + '?username_lower=ilike.' + enc + '&select=' + USER_FULL_COLS + '&order=credits.desc&limit=' + (limit || 25);
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase searchUsers ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbSetUserFields(key, fields) {
  const url = SB_URL + '/rest/v1/' + TABLE + '?username_lower=eq.' + encodeURIComponent(key);
  const r = await fetch(url, { method: 'PATCH', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(fields) });
  if (!r.ok) throw new Error('Supabase setUserFields ' + r.status + ': ' + (await r.text()));
}
async function sbAddAudit(row) {
  const r = await fetch(SB_URL + '/rest/v1/admin_audit', { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error('Supabase addAudit ' + r.status + ': ' + (await r.text()));
}
async function sbListAudit(limit) {
  const url = SB_URL + '/rest/v1/admin_audit?select=*&order=created_at.desc&limit=' + (limit || 150);
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listAudit ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbGetSettings() {
  const r = await fetch(SB_URL + '/rest/v1/app_settings?select=key,value', { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase getSettings ' + r.status + ': ' + (await r.text()));
  const rows = await r.json(); const o = {}; for (const x of rows) o[x.key] = x.value; return o;
}
async function sbSetSetting(key, value) {
  const r = await fetch(SB_URL + '/rest/v1/app_settings', {
    method: 'POST', headers: sbHeaders({ Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({ key: key, value: String(value), updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error('Supabase setSetting ' + r.status + ': ' + (await r.text()));
}
async function sbListAllTx(limit, kind) {
  let url = SB_URL + '/rest/v1/game_transactions?select=*&order=created_at.desc&limit=' + (limit || 100);
  if (kind) url += '&kind=eq.' + encodeURIComponent(kind);
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listAllTx ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbRpc(fn) {
  const r = await fetch(SB_URL + '/rest/v1/rpc/' + fn, { method: 'POST', headers: sbHeaders(), body: '{}' });
  if (!r.ok) throw new Error('Supabase rpc ' + fn + ' ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbListTaxEvents(limit) {
  const url = SB_URL + '/rest/v1/tax_events?select=*&order=occurred_at.desc&limit=' + (limit || 1000);
  const r = await fetch(url, { headers: sbHeaders() });
  if (!r.ok) throw new Error('Supabase listTaxEvents ' + r.status + ': ' + (await r.text()));
  return await r.json();
}
async function sbAddTaxEvent(row) {
  const r = await fetch(SB_URL + '/rest/v1/tax_events', { method: 'POST', headers: sbHeaders({ Prefer: 'return=minimal' }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error('Supabase addTaxEvent ' + r.status + ': ' + (await r.text()));
}
// ---- File ----
async function fileListUsersFull(limit) {
  return Object.values(users).map(u => ({
    username: u.username, username_lower: u.username_lower, credits: u.credits, wins: u.wins || 0,
    created_at: u.created_at, banned: !!u.banned, banned_reason: u.banned_reason || null, banned_at: u.banned_at || null,
    admin_note: u.admin_note || null, flagged: !!u.flagged, last_seen: u.last_seen || null,
  })).sort((a, b) => (b.credits || 0) - (a.credits || 0)).slice(0, limit || 500);
}
async function fileSearchUsers(q, limit) {
  q = String(q).toLowerCase();
  return (await fileListUsersFull(9999)).filter(u => u.username_lower.indexOf(q) >= 0).slice(0, limit || 25);
}
async function fileSetUserFields(key, fields) { if (users[key]) { Object.assign(users[key], fields); saveUsers(); } }
const AUDIT_FILE = path.join(DATA_DIR, 'audit.json');
let audit = []; try { audit = JSON.parse(fs.readFileSync(AUDIT_FILE, 'utf8')); } catch (e) { audit = []; }
async function fileAddAudit(row) {
  audit.push(Object.assign({ id: audit.length + 1, created_at: new Date().toISOString() }, row));
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(AUDIT_FILE, JSON.stringify(audit, null, 2)); } catch (e) {}
}
async function fileListAudit(limit) { return audit.slice().reverse().slice(0, limit || 150); }
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let settings = {}; try { settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch (e) { settings = {}; }
async function fileGetSettings() { return Object.assign({}, settings); }
async function fileSetSetting(key, value) {
  settings[key] = String(value);
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2)); } catch (e) {}
}
async function fileListAllTx(limit, kind) {
  let a = txs.slice().reverse(); if (kind) a = a.filter(t => t.kind === kind); return a.slice(0, limit || 100);
}
const TAX_FILE = path.join(DATA_DIR, 'tax_events.json');
let taxEvents = []; try { taxEvents = JSON.parse(fs.readFileSync(TAX_FILE, 'utf8')); } catch (e) { taxEvents = []; }
async function fileListTaxEvents(limit) { return taxEvents.slice().reverse().slice(0, limit || 1000); }
async function fileAddTaxEvent(row) {
  taxEvents.push(Object.assign({ id: taxEvents.length + 1, occurred_at: new Date().toISOString() }, row));
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(TAX_FILE, JSON.stringify(taxEvents, null, 2)); } catch (e) {}
}
async function fileRpc(fn) {
  if (fn === 'admin_finance') {
    const g = k => txs.filter(t => t.kind === k); const s = arr => arr.reduce((x, t) => x + (t.amount || 0), 0);
    return { deposit_count: g('deposit').length, deposit_credits: s(g('deposit')), deposit_pending_count: g('deposit_pending').length,
      deposit_pending_amt: s(g('deposit_pending')), withdraw_count: g('withdraw').length, withdraw_amt: s(g('withdraw')),
      withdraw_done_amt: s(g('withdraw_done')), refunded_amt: s(g('withdraw_refunded')), tx_24h: txs.length };
  }
  if (fn === 'admin_economy') {
    const arr = Object.values(users); const s = arr.reduce((x, u) => x + (u.credits || 0), 0);
    return { user_count: arr.length, total_credits: s, banned_count: arr.filter(u => u.banned).length,
      flagged_count: arr.filter(u => u.flagged).length, avg_credits: arr.length ? Math.round(s / arr.length) : 0,
      max_credits: arr.reduce((m, u) => Math.max(m, u.credits || 0), 0), total_wins: arr.reduce((x, u) => x + (u.wins || 0), 0), new_users_24h: 0 };
  }
  if (fn === 'admin_revenue_series') return [];
  if (fn === 'admin_tax') {
    const g = k => taxEvents.filter(t => t.kind === k); const s = a => a.reduce((x, t) => x + (t.usd_value || 0), 0);
    return { deposit_gross: s(g('deposit')), withdraw_paid: s(g('withdrawal')), event_count: taxEvents.length,
      deposit_count: g('deposit').length, withdraw_count: g('withdrawal').length, events_24h: taxEvents.length };
  }
  return {};
}

const adminSb = { listUsersFull: sbListUsersFull, searchUsers: sbSearchUsers, setUserFields: sbSetUserFields,
  addAudit: sbAddAudit, listAudit: sbListAudit, getSettings: sbGetSettings, setSetting: sbSetSetting, listAllTx: sbListAllTx, rpc: sbRpc,
  listTaxEvents: sbListTaxEvents, addTaxEvent: sbAddTaxEvent };
const adminFile = { listUsersFull: fileListUsersFull, searchUsers: fileSearchUsers, setUserFields: fileSetUserFields,
  addAudit: fileAddAudit, listAudit: fileListAudit, getSettings: fileGetSettings, setSetting: fileSetSetting, listAllTx: fileListAllTx, rpc: fileRpc,
  listTaxEvents: fileListTaxEvents, addTaxEvent: fileAddTaxEvent };

module.exports = useSupabase
  ? Object.assign({ backend: 'supabase', getUser: sbGetUser, createUser: sbCreateUser, updateCredits: sbUpdateCredits,
      recordWin: sbRecordWin, createWithdrawal: sbCreateWithdrawal,
      listUsers: sbListUsers, listWithdrawals: sbListWithdrawals, setWithdrawalStatus: sbSetWithdrawalStatus,
      txExists: sbTxExists, addTx: sbAddTx, getTx: sbGetTx, listTxByUser: sbListTxByUser }, adminSb)
  : Object.assign({ backend: 'file', getUser: fileGetUser, createUser: fileCreateUser, updateCredits: fileUpdateCredits,
      recordWin: fileRecordWin, createWithdrawal: fileCreateWithdrawal,
      listUsers: fileListUsers, listWithdrawals: fileListWithdrawals, setWithdrawalStatus: fileSetWithdrawalStatus,
      txExists: fileTxExists, addTx: fileAddTx, getTx: fileGetTx, listTxByUser: fileListTxByUser }, adminFile);
