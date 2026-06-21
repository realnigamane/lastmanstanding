// Last Man Standing - client (accounts + matchmaking + climb-or-die game)
(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  let ws = null, wsReady = false, pendingAuthToken = null;
  let myUsername = null, myCredits = 0;
  let snap = null;                 // latest game snapshot
  let curScreen = 'auth';
  const render = new Map();        // id -> {x,y} interpolated positions

  // ---------- Screens ----------
  const screens = ['auth', 'home', 'searching', 'game'];
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
      if (pendingAuthToken) { sendWS({ t: 'auth', token: pendingAuthToken }); pendingAuthToken = null; }
    };
    ws.onmessage = (ev) => handleMsg(JSON.parse(ev.data));
    ws.onclose = () => { wsReady = false; setTimeout(connect, 1000); };
  }
  function sendWS(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
  function authWith(token) { if (wsReady) sendWS({ t: 'auth', token }); else pendingAuthToken = token; }

  function handleMsg(m) {
    if (m.t === 'authed') {
      myUsername = m.username; myCredits = m.credits;
      $('hmUser').textContent = myUsername;
      $('hmCredits').textContent = myCredits;
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
      if (curScreen !== 'game') { render.clear(); showScreen('game'); }
    } else if (m.t === 'home') {
      // match ended or queue left
      const result = snap && snap.winner
        ? (snap.winner === myUsername ? '🏆 You won the last match!' : 'Winner: ' + snap.winner)
        : '';
      snap = null; render.clear();
      $('hmResult').textContent = result;
      showScreen('home');
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

  // ---------- Home ----------
  $('btnFind').onclick = () => { $('hmResult').textContent = ''; sendWS({ t: 'findMatch' }); };
  $('btnLogout').onclick = () => { localStorage.removeItem('lms_token'); location.reload(); };

  // ---------- Searching ----------
  $('btnCancel').onclick = () => { sendWS({ t: 'leaveMatch' }); showScreen('home'); };
  function renderSearching(m) {
    $('srFound').textContent = m.found;
    $('srTarget').textContent = m.target;
    $('srSub').textContent = m.found === 1 ? 'player searching' : 'players searching';
    $('srTimer').textContent = m.secs > 0
      ? 'Filling with bots in ' + m.secs + 's…'
      : 'Starting…';
    const dots = $('srDots');
    let html = '';
    for (let i = 0; i < m.target; i++) html += '<div class="slot ' + (i < m.found ? 'human' : '') + '"></div>';
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
    const ratio = W / H, pad = isTouch ? 8 : 24, reserveH = isTouch ? 8 : 70;
    let availW = window.innerWidth - pad * 2, availH = window.innerHeight - reserveH;
    let cw = availW, ch = availW / ratio;
    if (ch > availH) { ch = availH; cw = availH * ratio; }
    canvas.style.width = Math.floor(cw) + 'px';
    canvas.style.height = Math.floor(ch) + 'px';
  }
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 150));

  // ---------- Rendering ----------
  const lerp = (a, b, t) => a + (b - a) * t;
  function draw() {
    requestAnimationFrame(draw);
    if (curScreen !== 'game' || !snap || !snap.platforms) return;
    ctx.clearRect(0, 0, W, H);

    // Rising danger floor at the bottom — fall here and you're out.
    const dg = ctx.createLinearGradient(0, H - 80, 0, H);
    dg.addColorStop(0, 'rgba(255,60,80,0)');
    dg.addColorStop(1, 'rgba(255,40,70,0.42)');
    ctx.fillStyle = dg; ctx.fillRect(0, H - 80, W, 80);

    for (const p of snap.platforms) {
      if (p.y < -p.h || p.y > H) continue;
      ctx.fillStyle = '#46508c'; roundRect(p.x, p.y, p.w, p.h, 6);
      ctx.fillStyle = '#6b78cf'; ctx.fillRect(p.x + 3, p.y + 2, p.w - 6, 3);
    }
    for (const pl of snap.players) {
      let r = render.get(pl.id);
      if (!r) { r = { x: pl.x, y: pl.y }; render.set(pl.id, r); }
      if (Math.abs(pl.x - r.x) > 140 || Math.abs(pl.y - r.y) > 140) { r.x = pl.x; r.y = pl.y; }
      else { r.x = lerp(r.x, pl.x, 0.4); r.y = lerp(r.y, pl.y, 0.4); }
      drawPlayer(r.x, r.y, pl);
    }
    for (const id of [...render.keys()]) if (!snap.players.find(p => p.id === id)) render.delete(id);

    drawHUD(); drawPhaseOverlay();
  }
  function drawPlayer(x, y, pl) {
    const s = 28, cx = x + s / 2, cy = y + s / 2, r = 13;
    ctx.globalAlpha = pl.spectator ? 0.18 : 1;
    const dir = pl.vx < -0.4 ? -1 : pl.vx > 0.4 ? 1 : 0;
    // feet
    ctx.fillStyle = '#e25b7a';
    ctx.beginPath(); ctx.ellipse(cx - 7, y + s - 2, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + 7, y + s - 2, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
    // round body
    ctx.fillStyle = pl.color;
    ctx.beginPath(); ctx.arc(cx, cy - 1, r, 0, Math.PI * 2); ctx.fill();
    // highlight
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath(); ctx.arc(cx - 4, cy - 6, 5, 0, Math.PI * 2); ctx.fill();
    // blush cheeks
    ctx.fillStyle = 'rgba(255,120,150,0.55)';
    ctx.beginPath(); ctx.ellipse(cx - 8, cy + 3, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(cx + 8, cy + 3, 3, 2, 0, 0, Math.PI * 2); ctx.fill();
    // eyes (look the way you're moving)
    const ex = cx + dir * 2;
    ctx.fillStyle = '#1a2342';
    ctx.beginPath(); ctx.ellipse(ex - 4, cy - 3, 2.4, 4.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(ex + 4, cy - 3, 2.4, 4.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(ex - 4.6, cy - 5, 1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(ex + 3.4, cy - 5, 1, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    // name (bots get a tiny tag)
    ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = pl.id === myUsername ? '#9fffce' : (pl.bot ? '#8b95c9' : '#c9d2ff');
    ctx.fillText((pl.id === myUsername ? '▸ ' : '') + pl.name + (pl.bot ? ' ·bot' : ''), cx, y - 5);
  }
  function drawHUD() {
    ctx.textAlign = 'left'; ctx.font = 'bold 15px Segoe UI, sans-serif'; ctx.fillStyle = '#c9d2ff';
    ctx.fillText('Alive: ' + snap.alive + ' / ' + snap.total, 14, 24);
    if (snap.phase === 'playing') {
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffd479'; ctx.font = 'bold 15px Segoe UI, sans-serif';
      ctx.fillText('Survived: ' + snap.roundTime + 's', W - 14, 24);
      if (snap.roundTime < 6) {
        ctx.textAlign = 'center'; ctx.fillStyle = '#9fffce'; ctx.font = 'bold 15px Segoe UI, sans-serif';
        ctx.fillText('Climb! The floor is rising — keep jumping up', W / 2, 26);
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
  resizeCanvas();
  draw();
  connect();
  const saved = localStorage.getItem('lms_token');
  if (saved) authWith(saved);
})();
