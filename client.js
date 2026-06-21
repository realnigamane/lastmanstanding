// Last Man Standing - client (accounts + lobby + rooms + game)
(function () {
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas'), ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  let ws = null, wsReady = false, pendingAuthToken = null;
  let myUsername = null, myCredits = 0;
  let snap = null;            // latest room snapshot
  let curScreen = 'auth';
  const render = new Map();   // username -> {x,y} interpolated

  // ---------- Screens ----------
  const screens = ['auth', 'lobby', 'room', 'game'];
  function showScreen(name) {
    curScreen = name;
    for (const s of screens) $(s).classList.toggle('active', s === name);
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
      $('lbUser').textContent = myUsername;
      $('lbCredits').textContent = myCredits;
      showScreen('lobby');
    } else if (m.t === 'authfail') {
      localStorage.removeItem('lms_token');
      showScreen('auth');
      $('auErr').textContent = 'Session expired — please log in again.';
    } else if (m.t === 'rooms') {
      if (curScreen === 'lobby') renderRoomList(m.list);
    } else if (m.t === 'snapshot') {
      snap = m;
      onSnapshot();
    } else if (m.t === 'left') {
      snap = null; render.clear();
      showScreen('lobby');
    } else if (m.t === 'error') {
      $('lobErr').textContent = m.msg;
      setTimeout(() => { if ($('lobErr').textContent === m.msg) $('lobErr').textContent = ''; }, 3000);
    }
  }

  // ---------- Auth screen ----------
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

  // ---------- Lobby screen ----------
  $('btnQuick').onclick = () => sendWS({ t: 'quickPlay' });
  $('btnCreate').onclick = () => sendWS({ t: 'createRoom', maxPlayers: 8 });
  $('btnJoin').onclick = () => {
    const code = $('joinCode').value.trim().toUpperCase();
    if (code) sendWS({ t: 'joinRoom', code });
  };
  $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnJoin').click(); });
  $('btnLogout').onclick = () => { localStorage.removeItem('lms_token'); location.reload(); };

  function renderRoomList(list) {
    const open = list.filter(r => r.phase === 'waiting');
    const el = $('roomList');
    if (!list.length) { el.innerHTML = '<div class="muted" style="text-align:center">No open rooms yet — create one!</div>'; return; }
    el.innerHTML = list.map(r => {
      const live = r.phase !== 'waiting';
      return '<div class="roomitem"><div><span class="code">' + r.code + '</span>' +
        '<span class="pill">' + r.players + '/' + r.max + '</span>' +
        (live ? '<span class="pill live">in game</span>' : '') +
        '<div class="muted">host: ' + esc(r.host) + '</div></div>' +
        '<button data-code="' + r.code + '"' + (r.players >= r.max ? ' disabled' : '') + '>Join</button></div>';
    }).join('');
    el.querySelectorAll('button[data-code]').forEach(b => {
      b.onclick = () => sendWS({ t: 'joinRoom', code: b.getAttribute('data-code') });
    });
  }

  // ---------- Room screen ----------
  $('btnReady').onclick = () => {
    const me = snap && snap.members.find(x => x.username === myUsername);
    sendWS({ t: 'ready', value: !(me && me.ready) });
  };
  $('btnStart').onclick = () => sendWS({ t: 'startGame' });
  $('btnLeave').onclick = () => sendWS({ t: 'leaveRoom' });

  let lastRoomKey = '';
  function renderRoom() {
    const amHost = snap.host === myUsername;
    $('rmCode').textContent = snap.code;
    const enough = snap.members.length >= snap.minToStart;
    $('rmStatus').textContent = enough
      ? (amHost ? 'Ready when you are — press Start.' : 'Waiting for the host to start…')
      : ('Waiting for players… need at least ' + snap.minToStart + ' (open another tab or share the code).');
    $('rmMembers').innerHTML = snap.members.map(mm =>
      '<div class="member"><span class="dot" style="background:' + mm.color + '"></span>' +
      '<span class="nm">' + esc(mm.username) + (mm.username === myUsername ? ' (you)' : '') + '</span>' +
      (mm.isHost ? '<span class="badge host">host</span>'
                 : '<span class="badge ' + (mm.ready ? 'ready' : 'wait') + '">' + (mm.ready ? 'ready' : 'not ready') + '</span>') +
      '</div>').join('');
    const me = snap.members.find(x => x.username === myUsername);
    $('btnReady').textContent = me && me.ready ? '✓ Ready' : "I'm ready";
    $('btnStart').style.display = amHost ? '' : 'none';
    $('btnStart').disabled = !enough;
    $('rmHostNote').textContent = amHost
      ? 'You are the host. The match auto-starts when the room is full (' + snap.maxPlayers + ').'
      : 'Host: ' + snap.host;
  }

  function onSnapshot() {
    document.body.classList.toggle('playing', snap.phase === 'playing');
    if (snap.phase === 'waiting') {
      if (curScreen !== 'room') showScreen('room');
      const key = JSON.stringify(snap.members) + snap.host + snap.code;
      if (key !== lastRoomKey) { lastRoomKey = key; renderRoom(); }
    } else {
      lastRoomKey = '';
      if (curScreen !== 'game') showScreen('game');
    }
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
    ctx.fillStyle = 'rgba(255,80,80,0.06)';
    ctx.fillRect(0, H - 26, W, 26);

    for (const p of snap.platforms) {
      ctx.fillStyle = '#46508c'; roundRect(p.x, p.y, p.w, p.h, 6);
      ctx.fillStyle = '#5d68b8'; ctx.fillRect(p.x + 3, p.y + 2, p.w - 6, 3);
    }
    for (const pl of snap.players) {
      let r = render.get(pl.id);
      if (!r) { r = { x: pl.x, y: pl.y }; render.set(pl.id, r); }
      r.x = lerp(r.x, pl.x, 0.35); r.y = lerp(r.y, pl.y, 0.35);
      drawPlayer(r.x, r.y, pl);
    }
    for (const id of [...render.keys()]) if (!snap.players.find(p => p.id === id)) render.delete(id);

    drawHUD(); drawPhaseOverlay();
  }
  function drawPlayer(x, y, pl) {
    const size = 30;
    ctx.globalAlpha = pl.spectator ? 0.25 : 1;
    ctx.fillStyle = pl.color; roundRect(x, y, size, size, 7);
    const dir = pl.vx < -0.3 ? -1 : pl.vx > 0.3 ? 1 : 0;
    ctx.fillStyle = '#0b0e1a';
    const ex = x + 9 + dir * 3, ey = y + 11;
    ctx.fillRect(ex, ey, 4, 5); ctx.fillRect(ex + 9, ey, 4, 5);
    ctx.globalAlpha = 1;
    ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = pl.id === myUsername ? '#9fffce' : '#c9d2ff';
    ctx.fillText((pl.id === myUsername ? '▸ ' : '') + pl.name, x + size / 2, y - 6);
  }
  function drawHUD() {
    const total = snap.members.length;
    ctx.textAlign = 'left'; ctx.font = 'bold 15px Segoe UI, sans-serif'; ctx.fillStyle = '#c9d2ff';
    ctx.fillText('Alive: ' + snap.alive + ' / ' + total, 14, 24);
    ctx.textAlign = 'center'; ctx.fillStyle = '#8b95c9'; ctx.font = '12px Segoe UI, sans-serif';
    ctx.fillText('Room ' + snap.code, W / 2, 22);
    if (snap.phase === 'playing') {
      ctx.textAlign = 'right'; ctx.fillStyle = '#ffd479'; ctx.font = 'bold 15px Segoe UI, sans-serif';
      ctx.fillText('Survived: ' + snap.roundTime + 's', W - 14, 24);
      const diff = Math.min(1, snap.roundTime / 60);
      ctx.fillStyle = '#23284a'; ctx.fillRect(W - 174, 32, 160, 6);
      ctx.fillStyle = diff > .66 ? '#ff5252' : diff > .33 ? '#ffb142' : '#32ff7e';
      ctx.fillRect(W - 174, 32, 160 * diff, 6);
    }
  }
  function drawPhaseOverlay() {
    if (snap.phase === 'countdown') {
      shade(); center('Get ready!', '#fff', 26, -28); center(String(snap.countdown), '#4be3ff', 64, 26);
    } else if (snap.phase === 'roundover') {
      shade();
      if (snap.winner) center('🏆  ' + snap.winner + '  wins!', '#ffd479', 36, -10);
      else center('Draw — everyone fell!', '#ff8a8a', 30, -10);
      center('Back to the room in ' + snap.countdown + '…', '#8b95c9', 16, 30);
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
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---------- Boot ----------
  setAuthMode('login');
  resizeCanvas();
  draw();
  connect();
  const saved = localStorage.getItem('lms_token');
  if (saved) authWith(saved);
})();
