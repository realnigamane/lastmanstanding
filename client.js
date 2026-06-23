// Last Duck Standing - client (accounts + matchmaking + climb-or-die game)
(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  let ws = null, wsReady = false, authToken = null;
  let myUsername = null, myCredits = 0;
  let snap = null;                 // latest game snapshot
  let curScreen = 'auth';
  const render = new Map();        // id -> {x,y} interpolated player positions
  const platRender = new Map();    // id -> {x,y} interpolated platform positions
  const haz = [];                  // interpolated hazard positions
  let shake = 0;                   // screen-shake amount (decays)
  const stars = [];                // decorative parallax starfield

  // ---------- Screens ----------
  const screens = ['auth', 'boot', 'home', 'searching', 'game'];
  function showScreen(name) {
    curScreen = name;
    for (const s of screens) $(s).classList.toggle('active', s === name);
    document.body.classList.toggle('playing', name === 'game');
    if (name === 'game') resizeCanvas();
  }

  // ---------- WebSocket ----------
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host);
    ws.onopen = () => {
      wsReady = true;
      if (authToken) sendWS({ t: 'auth', token: authToken });   // (re)authenticate on EVERY (re)connect
    };
    ws.onmessage = (ev) => handleMsg(JSON.parse(ev.data));
    ws.onerror = () => { try { ws.close(); } catch (e) {} };
    ws.onclose = () => { wsReady = false; setTimeout(connect, 1000); };
  }
  function sendWS(obj) {
    if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    ensureConnected();   // socket missing/closed (common on iOS after lock/backgrounding) — revive it
    return false;
  }
  function authWith(token) { authToken = token; if (wsReady) sendWS({ t: 'auth', token }); }
  // iOS/Safari aggressively suspends WebSockets when the tab is backgrounded or the phone
  // is locked. Reconnect (which re-authenticates) whenever we return to the page or try to
  // send on a dead socket, so buttons like "Find Match" never silently do nothing.
  function ensureConnected() { if (!ws || ws.readyState > 1) connect(); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) ensureConnected(); });
  window.addEventListener('pageshow', ensureConnected);
  window.addEventListener('focus', ensureConnected);

  function handleMsg(m) {
    if (m.t === 'authed') {
      myUsername = m.username; myCredits = m.credits;
      $('hmUser').textContent = myUsername;
      $('hmCredits').textContent = myCredits;
      if (m.rank) $('hmRank').textContent = m.rank.tier;
      $('hmWins').textContent = m.wins != null ? m.wins : 0;
      showScreen('home');
    } else if (m.t === 'authfail') {
      localStorage.removeItem('lms_token');
      showScreen('auth');
      $('auErr').textContent = 'Session expired — please log in again.';
    } else if (m.t === 'searching') {
      renderSearching(m);
      if (curScreen !== 'searching') showScreen('searching');
    } else if (m.t === 'snapshot') {
      snap = m;
      if (curScreen !== 'game') { render.clear(); platRender.clear(); haz.length = 0; showScreen('game'); }
    } else if (m.t === 'home') {
      let result = snap && snap.winner
        ? (snap.winner === myUsername ? '🏆 You won!' : 'Winner: ' + snap.winner)
        : '';
      if (m.won && m.payout) result = '🏆 You won! +' + m.payout + ' credits';
      if (m.wins != null) $('hmWins').textContent = m.wins;
      if (m.rank) $('hmRank').textContent = m.rank.tier;
      if (m.credits != null) { myCredits = m.credits; $('hmCredits').textContent = m.credits; }
      snap = null; render.clear(); platRender.clear(); haz.length = 0;
      $('hmResult').textContent = result;
      showScreen('home');
    } else if (m.t === 'credits') {
      myCredits = m.credits; $('hmCredits').textContent = m.credits;
    } else if (m.t === 'matchError') {
      $('hmResult').textContent = m.error || 'Could not start match.';
    } else if (m.t === 'withdrawResult') {
      $('wdMsg').textContent = m.ok ? ('✓ Requested ' + m.amount + ' credits — pending review') : (m.error || 'Could not submit.');
    }
  }

  // ---------- Auth ----------
  let authMode = 'login';
  function setAuthMode(mode) {
    authMode = mode;
    $('tabLogin').classList.toggle('sel', mode === 'login');
    $('tabRegister').classList.toggle('sel', mode === 'register');
    $('auGo').textContent = mode === 'login' ? 'Log in' : 'Create account';
    $('auPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    $('auErr').textContent = '';
  }
  $('tabLogin').onclick = () => setAuthMode('login');
  $('tabRegister').onclick = () => setAuthMode('register');

  async function submitAuth() {
    const username = $('auUser').value.trim(), password = $('auPass').value;
    $('auErr').textContent = '';
    if (!username || !password) { $('auErr').textContent = 'Enter a username and password.'; return; }
    try {
      const r = await fetch('/api/' + (authMode === 'login' ? 'login' : 'register'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json();
      if (d.error) { $('auErr').textContent = d.error; return; }
      localStorage.setItem('lms_token', d.token);
      myUsername = d.username; myCredits = d.credits;
      authWith(d.token);
    } catch (e) {
      $('auErr').textContent = 'Could not reach the server. Is it running?';
    }
  }
  $('auGo').onclick = submitAuth;
  $('auPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });
  $('auUser').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('auPass').focus(); });

  // ---------- Home / dashboard ----------
  $('btnFind').onclick = () => { $('hmResult').textContent = ''; if (!sendWS({ t: 'findMatch' })) $('hmResult').textContent = 'Reconnecting… tap again in a second.'; };
  $('btnLogout').onclick = () => { localStorage.removeItem('lms_token'); location.reload(); };
  $('btnDeposit').onclick = async () => {
    const amt = parseInt($('depAmt').value, 10);
    if (!amt || amt <= 0) { $('depMsg').textContent = 'Enter a valid amount.'; return; }
    $('depMsg').textContent = 'Creating your invoice…';
    try {
      const r = await fetch('/api/deposit/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: authToken, amount: amt }) });
      const d = await r.json();
      if (d.error) { $('depMsg').textContent = d.error; return; }
      $('depMsg').textContent = 'Opening payment window — your balance updates once the payment confirms on-chain.';
      window.open(d.checkoutLink, '_blank');
    } catch (e) { $('depMsg').textContent = 'Could not start deposit. Try again.'; }
  };
  $('btnWithdraw').onclick = async () => {
    const amt = parseInt($('wdAmt').value, 10);
    const coin = wdCoin;
    const address = $('wdAddr').value.trim();
    if (!amt || amt < 10) { $('wdMsg').textContent = 'Minimum withdrawal is 10 credits.'; return; }
    if (!address) { $('wdMsg').textContent = 'Enter your ' + coin + ' address.'; return; }
    $('wdMsg').textContent = 'Submitting…';
    try {
      const r = await fetch('/api/withdraw/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: authToken, amount: amt, coin: coin, address: address }) });
      const d = await r.json();
      if (d.error) { $('wdMsg').textContent = d.error; return; }
      if (d.credits != null) { myCredits = d.credits; $('hmCredits').textContent = d.credits; }
      $('wdMsg').textContent = d.message || '✓ Withdrawal sent — it pays out automatically.';
      $('wdAmt').value = ''; $('wdCryptoAmt').value = '';
    } catch (e) { $('wdMsg').textContent = 'Could not submit withdrawal. Try again.'; }
  };

  // ---------- Live USD <-> crypto converters (deposit + withdraw) ----------
  let RATES = { btc: 0, ltc: 0 };
  let depCoin = 'BTC', wdCoin = 'BTC';
  const rateOf = (coin) => (coin === 'LTC' ? RATES.ltc : RATES.btc);
  const trimCrypto = (n) => { if (!isFinite(n) || n <= 0) return ''; return n.toFixed(8).replace(/\.?0+$/, ''); };
  const priceLine = (coin) => { const r = rateOf(coin); return r ? ('Live price: 1 ' + coin + ' ≈ $' + r.toLocaleString(undefined, { maximumFractionDigits: 2 })) : 'Live price loading…'; };

  function refreshDep() { $('depCoinLbl').textContent = depCoin; $('depRate').textContent = priceLine(depCoin); }
  function depFromUsd() { const usd = parseFloat($('depAmt').value) || 0; const r = rateOf(depCoin); $('depCrypto').value = (usd > 0 && r) ? trimCrypto(usd / r) : ''; refreshDep(); }
  function depFromCrypto() { const c = parseFloat($('depCrypto').value) || 0; const r = rateOf(depCoin); $('depAmt').value = (c > 0 && r) ? (c * r).toFixed(2) : ''; refreshDep(); }

  function refreshWd() { $('wdCoinLbl').textContent = wdCoin; $('wdAddr').placeholder = 'Your ' + wdCoin + ' address'; $('wdRate').textContent = priceLine(wdCoin); }
  function wdFromUsd() { const usd = parseFloat($('wdAmt').value) || 0; const r = rateOf(wdCoin); $('wdCryptoAmt').value = (usd > 0 && r) ? trimCrypto(usd / r) : ''; refreshWd(); }
  function wdFromCrypto() { const c = parseFloat($('wdCryptoAmt').value) || 0; const r = rateOf(wdCoin); $('wdAmt').value = (c > 0 && r) ? (c * r).toFixed(2) : ''; refreshWd(); }

  $('depAmt').addEventListener('input', depFromUsd);
  $('depCrypto').addEventListener('input', depFromCrypto);
  $('wdAmt').addEventListener('input', wdFromUsd);
  $('wdCryptoAmt').addEventListener('input', wdFromCrypto);

  document.querySelectorAll('#depCoinPick .coinbtn').forEach((b) => { b.onclick = () => { depCoin = b.getAttribute('data-coin'); document.querySelectorAll('#depCoinPick .coinbtn').forEach((x) => x.classList.toggle('sel', x === b)); depFromUsd(); }; });
  document.querySelectorAll('#wdCoinPick .coinbtn').forEach((b) => { b.onclick = () => { wdCoin = b.getAttribute('data-coin'); document.querySelectorAll('#wdCoinPick .coinbtn').forEach((x) => x.classList.toggle('sel', x === b)); wdFromUsd(); }; });

  async function loadRates() {
    try { const d = await (await fetch('/api/rates', { cache: 'no-store' })).json(); if (d && d.btc) RATES = { btc: d.btc, ltc: d.ltc }; } catch (e) {}
    refreshDep(); refreshWd();
    if ($('depAmt').value) depFromUsd();
    if ($('wdAmt').value) wdFromUsd();
  }
  loadRates();
  setInterval(loadRates, 30000);
  $('btnCash').onclick = () => { const w = $('wagerPick'); w.style.display = (w.style.display === 'none' || !w.style.display) ? 'block' : 'none'; };
  document.querySelectorAll('.wager').forEach(b => { b.onclick = () => { $('hmResult').textContent = ''; if (!sendWS({ t: 'findMatch', wager: parseInt(b.getAttribute('data-w'), 10) })) $('hmResult').textContent = 'Reconnecting… tap again in a second.'; }; });

  // ---------- Searching ----------
  $('btnCancel').onclick = () => { sendWS({ t: 'leaveMatch' }); showScreen('home'); };
  function renderSearching(m) {
    const tail = m.wager > 0 ? (' · 💰 pot ' + m.pot) : '';
    $('srTimer').textContent = (m.secs > 0 ? 'Match starting in ' + m.secs + 's…' : 'Starting…') + tail;
    const dots = $('srDots');
    const lit = Math.min(m.target, Math.max(m.found, m.target - m.secs));
    let html = '';
    for (let i = 0; i < m.target; i++) html += '<div class="slot ' + (i < lit ? 'human' : '') + '"></div>';
    dots.innerHTML = html;
  }

  // ---------- Input ----------
  const input = { left: false, right: false, jump: false };
  let lastSent = '';
  function sendInput() {
    const sig = (input.left ? 'L' : '') + (input.right ? 'R' : '') + (input.jump ? 'J' : '');
    if (sig === lastSent) return;
    lastSent = sig;
    sendWS({ t: 'input', left: input.left, right: input.right, jump: input.jump });
  }
  function setKey(e, down) {
    let used = true;
    switch (e.key) {
      case 'ArrowLeft': case 'a': case 'A': input.left = down; break;
      case 'ArrowRight': case 'd': case 'D': input.right = down; break;
      case 'ArrowUp': case 'w': case 'W': case ' ': input.jump = down; break;
      default: used = false;
    }
    if (used && curScreen === 'game') { e.preventDefault(); sendInput(); }
  }
  window.addEventListener('keydown', (e) => { if (!e.repeat) setKey(e, true); });
  window.addEventListener('keyup', (e) => setKey(e, false));

  // Touch controls
  const isTouch = window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) document.body.classList.add('touch');
  function bindHold(el, key) {
    if (!el) return;
    const down = (e) => { e.preventDefault(); input[key] = true; el.classList.add('active');
      try { el.setPointerCapture(e.pointerId); } catch (_) {} sendInput(); };
    const up = (e) => { e.preventDefault(); input[key] = false; el.classList.remove('active'); sendInput(); };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('touchstart', down, { passive: false });
    el.addEventListener('touchend', up, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  bindHold($('btnLeft'), 'left'); bindHold($('btnRight'), 'right'); bindHold($('btnJump'), 'jump');

  function resizeCanvas() {
    const ratio = W / H, pad = isTouch ? 0 : 24, reserveH = isTouch ? 0 : 70;
    let availW = window.innerWidth - pad * 2, availH = window.innerHeight - reserveH;
    let cw = availW, ch = availW / ratio;
    if (ch > availH) { ch = availH; cw = availH * ratio; }
    canvas.style.width = Math.floor(cw) + 'px';
    canvas.style.height = Math.floor(ch) + 'px';
    if (isTouch) {                       // use the whole screen on phones
      const g = $('game'); if (g) g.style.padding = '0';
      const h = $('hint'); if (h) h.style.display = 'none';
    }
  }
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 150));

  // ---------- Rendering ----------
  const lerp = (a, b, t) => a + (b - a) * t;

  function initStars() {
    for (let i = 0; i < 80; i++) stars.push({ x: Math.random() * W, y: Math.random() * H, z: 0.4 + Math.random() * 1.0 });
  }
  function drawStars() {
    const sp = (snap && snap.scroll ? snap.scroll : 30);
    for (const s of stars) {
      s.y += (s.z * sp) / 520;
      if (s.y > H) { s.y -= H; s.x = Math.random() * W; }
      ctx.globalAlpha = 0.12 + s.z * 0.35;
      ctx.fillStyle = '#aab6ff';
      ctx.fillRect(s.x, s.y, s.z * 1.8, s.z * 1.8);
    }
    ctx.globalAlpha = 1;
  }

  function draw() {
    requestAnimationFrame(draw);
    if (curScreen !== 'game' || !snap || !snap.platforms) return;

    ctx.save();
    if (shake > 0) {
      const m = shake * 7;
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
      shake = Math.max(0, shake - 0.06);
    }
    ctx.clearRect(-30, -30, W + 60, H + 60);
    drawStars();

    // rising danger floor
    const dg = ctx.createLinearGradient(0, H - 80, 0, H);
    dg.addColorStop(0, 'rgba(255,60,80,0)');
    dg.addColorStop(1, 'rgba(255,40,70,0.42)');
    ctx.fillStyle = dg; ctx.fillRect(0, H - 80, W, 80);

    // platforms (interpolated like players so the scrolling field stays smooth)
    for (const p of snap.platforms) {
      let rp = platRender.get(p.id);
      if (!rp) { rp = { x: p.x, y: p.y }; platRender.set(p.id, rp); }
      if (Math.abs(p.x - rp.x) > 160 || Math.abs(p.y - rp.y) > 160) { rp.x = p.x; rp.y = p.y; }
      else { rp.x = lerp(rp.x, p.x, 0.4); rp.y = lerp(rp.y, p.y, 0.4); }
      if (rp.y < -p.h || rp.y > H) continue;
      ctx.save();
      ctx.shadowColor = 'rgba(99,120,255,0.55)'; ctx.shadowBlur = 10;
      ctx.fillStyle = '#46508c'; roundRect(rp.x, rp.y, p.w, p.h, 6);
      ctx.restore();
      ctx.fillStyle = '#6b78cf'; ctx.fillRect(rp.x + 3, rp.y + 2, p.w - 6, 3);
    }
    { const live = new Set(snap.platforms.map(p => p.id));
      for (const id of [...platRender.keys()]) if (!live.has(id)) platRender.delete(id); }

    // players
    for (const pl of snap.players) {
      let r = render.get(pl.id);
      if (!r) { r = { x: pl.x, y: pl.y }; render.set(pl.id, r); }
      if (Math.abs(pl.x - r.x) > 140 || Math.abs(pl.y - r.y) > 140) { r.x = pl.x; r.y = pl.y; }
      else { r.x = lerp(r.x, pl.x, 0.4); r.y = lerp(r.y, pl.y, 0.4); }
      drawPlayer(r.x, r.y, pl);
    }
    for (const id of [...render.keys()]) if (!snap.players.find(p => p.id === id)) render.delete(id);

    drawHazards();

    // local-player got knocked -> flash + shake
    const me = snap.players.find(p => p.id === myUsername);
    if (me && me.hit) { shake = Math.max(shake, 1); ctx.fillStyle = 'rgba(255,40,60,0.20)'; ctx.fillRect(0, 0, W, H); }

    drawHUD(); drawPhaseOverlay();
    ctx.restore();
  }

  function drawHazards() {
    if (!snap.hazards) return;
    for (let i = 0; i < snap.hazards.length; i++) {
      const b = snap.hazards[i];
      let h = haz[i]; if (!h) { h = { x: b.x, y: b.y }; haz[i] = h; }
      if (Math.abs(b.x - h.x) > 120 || Math.abs(b.y - h.y) > 120) { h.x = b.x; h.y = b.y; }
      else { h.x = lerp(h.x, b.x, 0.5); h.y = lerp(h.y, b.y, 0.5); }
      const g = ctx.createRadialGradient(h.x, h.y, 2, h.x, h.y, b.r * 2.3);
      g.addColorStop(0, 'rgba(255,214,128,0.9)');
      g.addColorStop(0.5, 'rgba(255,120,60,0.45)');
      g.addColorStop(1, 'rgba(255,80,40,0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h.x, h.y, b.r * 2.3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ff9f2e'; ctx.beginPath(); ctx.arc(h.x, h.y, b.r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.75)'; ctx.beginPath(); ctx.arc(h.x - b.r * 0.3, h.y - b.r * 0.3, b.r * 0.35, 0, Math.PI * 2); ctx.fill();
    }
    haz.length = snap.hazards.length;
  }

  function drawPlayer(x, y, pl) {
    const s = 28, cx = x + s / 2, cy = y + s / 2;
    const dir = pl.vx < -0.4 ? -1 : 1;   // face the way you're moving (default right)
    // soft shadow
    ctx.globalAlpha = pl.spectator ? 0.1 : 0.28;
    ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(cx, y + s + 1, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = pl.spectator ? 0.22 : 1;

    // pixel duck — blocks in local coords, mirrored when facing left
    const px = (gx, gy, w, h, col) => {
      ctx.fillStyle = col;
      const fx = dir >= 0 ? gx : -gx - w;
      ctx.fillRect(Math.round(cx + fx), Math.round(cy + gy), w, h);
    };
    const body = pl.color, beak = '#ffae2e', foot = '#ff8a1e', eye = '#1a2342';
    px(-6, 9, 3, 3, foot); px(0, 9, 3, 3, foot);          // feet
    px(-10, 1, 17, 8, body); px(-8, -1, 14, 2, body); px(-9, 9, 14, 1, body); // body
    px(2, -9, 9, 8, body); px(3, -11, 7, 2, body);        // head
    px(-7, 2, 7, 4, 'rgba(0,0,0,0.16)');                  // wing shade
    px(11, -6, 6, 3, beak); px(11, -3, 4, 2, beak);       // beak
    px(6, -7, 3, 3, eye); px(7, -7, 1, 1, '#fff');        // eye + glint
    if (pl.hit) { ctx.strokeStyle = '#ff5a72'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(cx, cy, 15, 0, Math.PI * 2); ctx.stroke(); }
    ctx.globalAlpha = 1;
    // name
    ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = pl.id === myUsername ? '#9fffce' : '#c9d2ff';
    ctx.fillText((pl.id === myUsername ? '▸ ' : '') + pl.name, cx, y - 7);
  }
  function drawHUD() {
    ctx.textAlign = 'left'; ctx.font = 'bold 15px Segoe UI, sans-serif'; ctx.fillStyle = '#c9d2ff';
    ctx.fillText('Alive: ' + snap.alive + ' / ' + snap.total, 14, 24);
    if (snap.wager > 0) { ctx.fillStyle = '#ffd479'; ctx.fillText('💰 Pot ' + snap.pot, 14, 44); }
    if (snap.phase === 'playing') {
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffd479'; ctx.font = 'bold 15px Segoe UI, sans-serif';
      ctx.fillText('Survived: ' + snap.roundTime + 's', W - 14, 24);
      if (snap.roundTime < 6) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#9fffce'; ctx.font = 'bold 15px Segoe UI, sans-serif';
        ctx.fillText('Climb! The floor is rising — keep jumping up', W / 2, 26);
      } else if (snap.roundTime < 11 && snap.hazards && snap.hazards.length) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#ffae42'; ctx.font = 'bold 15px Segoe UI, sans-serif';
        ctx.fillText('Watch out — dodge the balls!', W / 2, 26);
      }
    }
  }
  function drawPhaseOverlay() {
    if (snap.phase === 'countdown') {
      shade(); center('Get ready to climb!', '#fff', 26, -28); center(String(snap.countdown), '#4be3ff', 64, 26);
    } else if (snap.phase === 'roundover') {
      shade();
      if (snap.winner) {
        const mine = snap.winner === myUsername;
        center(mine ? '🏆  You win!' : '🏆  ' + snap.winner + '  wins!', mine ? '#9fffce' : '#ffd479', 34, -10);
      } else center('Draw — everyone fell!', '#ff8a8a', 30, -10);
      center('Back to menu in ' + snap.countdown + '…', '#8b95c9', 16, 30);
    }
  }
  function shade() { ctx.fillStyle = 'rgba(7,9,20,0.55)'; ctx.fillRect(0, 0, W, H); }
  function center(text, color, size, dy = 0) {
    ctx.textAlign = 'center'; ctx.fillStyle = color;
    ctx.font = 'bold ' + size + 'px Segoe UI, sans-serif';
    ctx.fillText(text, W / 2, H / 2 + dy);
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath(); ctx.fill();
  }

  // ---------- Boot ----------
  setAuthMode('login');
  initStars();
  resizeCanvas();
  draw();
  connect();
  const saved = localStorage.getItem('lms_token');
  if (saved) {
    // Show a brief loading splash (not the login screen) while we re-authenticate,
    // so a page refresh never flashes "logged out".
    showScreen('boot');
    authWith(saved);
    // Safety net: if re-auth doesn't land (bad/expired token, no connection), fall back to login.
    setTimeout(() => { if (curScreen === 'boot') showScreen('auth'); }, 7000);
  } else {
    showScreen('auth');
  }
})();
