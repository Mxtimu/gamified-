/* ══════════════════════════════════════════════════════════════════════════
   Grid Guardians — client
   Three-move Stealth Quest: drop the pin → drop the intel → drop the proof.
   ══════════════════════════════════════════════════════════════════════════ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = async (path, opts) => {
  const r = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
    method: opts?.body ? (opts.method || 'POST') : (opts?.method || 'GET'),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { data });
  return data;
};

const S = {
  callsign: localStorage.getItem('msotra.callsign') || '',
  agent: null,
  zones: [],
  boot: null,
  pin: null,
  category: 'cable_theft',
  severity: 3,
  chat: [],
  media: [],
  escape: null,
};

// ── map projection ────────────────────────────────────────────────────────
const LAT_TOP = -26.200, LAT_BOT = -26.295, LNG_L = 27.790, LNG_R = 27.965;
const MW = 1000, MH = 620;
const px = (lng) => ((lng - LNG_L) / (LNG_R - LNG_L)) * MW;
const py = (lat) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOT)) * MH;
const toLng = (x) => LNG_L + (x / MW) * (LNG_R - LNG_L);
const toLat = (y) => LAT_TOP - (y / MH) * (LAT_TOP - LAT_BOT);

const healthColour = (h) => (h >= 75 ? '#38e07b' : h >= 45 ? '#ffb703' : '#ff4d4d');
const CAT_LABEL = {
  cable_theft: 'Cable theft', substation_vandalism: 'Substation vandalised',
  open_chamber: 'Open chamber', illegal_connection: 'Illegal connection',
  streetlight_out: 'Streetlights out',
};

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// ── tabs ──────────────────────────────────────────────────────────────────
function show(view) {
  $$('nav.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === view)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'wallet') loadWallet();
  if (view === 'hood') loadBoards();
  if (view === 'ghost') { renderStages(); loadAudit(); runScrub(); }
  if (view === 'proof') renderDraft();
}
$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => { SFX.play('tick'); show(b.dataset.view); }));

$('#muteBtn').addEventListener('click', (e) => {
  e.target.textContent = SFX.toggle() ? '🔊 SFX' : '🔇 SFX';
});

// ── bootstrap ─────────────────────────────────────────────────────────────
async function boot() {
  const q = S.callsign ? `?callsign=${encodeURIComponent(S.callsign)}` : '';
  S.boot = await api(`/api/bootstrap${q}`);
  S.zones = S.boot.zones;
  S.agent = S.boot.agent;

  $('#homeZone').innerHTML = S.zones
    .map((z) => `<option value="${z.id}">${z.name} — ${z.landmark}</option>`).join('');
  if (S.callsign) $('#callsign').value = S.callsign;
  if (S.agent?.home_zone_id) $('#homeZone').value = S.agent.home_zone_id;

  $('#safetyText').textContent = S.boot.safety.prompt;
  $('#safetyRules').innerHTML = S.boot.safety.rules.map((r) => `<li>${r}</li>`).join('');
  $('#hotlines').innerHTML = S.boot.hotline.map((h) => `
    <div class="stat"><span>${h.name}</span><b style="font-size:17px">${h.number}</b></div>`).join('');

  renderHud();
  renderMap();
  renderFeed();
  seedChat();
  renderHqStats();
}

function renderHud() {
  const a = S.agent;
  $('#ghostId').textContent = a ? a.ghost_id : 'NOT ENLISTED';
  $('#rankName').textContent = a ? `${a.badge} ${a.rank}` : 'Observer';
  $('#coinCount').textContent = a ? a.coins : 0;
  $('#enlistNote').innerHTML = a
    ? `Enlisted. Authorities will only ever see <b class="mono" style="color:var(--teal)">${a.ghost_id}</b> — never "${a.callsign}", never a number.`
    : 'Your callsign never leaves this device. We generate an unlinkable ghost handle for you.';
}

function renderHqStats() {
  const totals = S.boot.crews.reduce((acc, c) => ({
    reports: acc.reports + c.reports, verified: acc.verified + c.verified, coins: acc.coins + c.coins,
  }), { reports: 0, verified: 0, coins: 0 });
  $('#hqStats').innerHTML = `
    <div class="stat"><b>${totals.reports}</b><span>Total intel drops</span></div>
    <div class="stat"><b>${totals.verified}</b><span>Verified by authorities</span></div>
    <div class="stat"><b>${totals.coins}</b><span>Msotra Coins paid out</span></div>`;
}

$('#enlistBtn').addEventListener('click', async () => {
  const cs = $('#callsign').value.trim();
  if (!cs) return toast('Pick a callsign first, Msotra.');
  const { agent } = await api('/api/agent', { body: { callsign: cs, home_zone_id: Number($('#homeZone').value) } });
  S.callsign = cs;
  S.agent = agent;
  localStorage.setItem('msotra.callsign', cs);
  SFX.play('rankup');
  renderHud();
  toast(`Welcome, ${agent.ghost_id}. Ghost Agent armed.`);
  show('map');
});

// ── map ───────────────────────────────────────────────────────────────────
function renderMap() {
  const links = [[0, 1], [1, 2], [0, 5], [5, 7], [7, 8], [8, 10], [8, 9], [9, 11], [3, 4], [4, 6], [6, 1], [3, 8], [4, 0]];
  const zoneById = (i) => S.zones[i];

  const grid = links.filter(([a, b]) => zoneById(a) && zoneById(b)).map(([a, b]) => {
    const A = zoneById(a), B = zoneById(b);
    return `<line x1="${px(A.lng)}" y1="${py(A.lat)}" x2="${px(B.lng)}" y2="${py(B.lat)}"
      stroke="#23233a" stroke-width="2" stroke-dasharray="7 6"/>`;
  }).join('');

  const nodes = S.zones.map((z) => {
    const x = px(z.lng), y = py(z.lat), c = healthColour(z.grid_health);
    const hot = z.grid_health < 45;
    return `<g class="zone-hit" data-zone="${z.id}" data-lat="${z.lat}" data-lng="${z.lng}">
      ${hot ? `<circle cx="${x}" cy="${y}" r="9" fill="${c}" opacity=".5" class="pulse"/>` : ''}
      <circle class="zone-node" cx="${x}" cy="${y}" r="${9 + Math.min(6, z.reports)}"
        fill="${c}" opacity=".9" stroke="#08080d" stroke-width="2"/>
      <text class="zone-label" x="${x}" y="${y - 17}" text-anchor="middle">${z.name}</text>
      <text class="zone-label" x="${x}" y="${y + 26}" text-anchor="middle"
        style="font-size:9px;fill:#6f6f8c">${z.grid_health}% grid · ${z.reports} drops</text>
    </g>`;
  }).join('');

  $('#mapWrap').innerHTML = `
  <svg viewBox="0 0 ${MW} ${MH}" id="mapSvg" role="img" aria-label="Soweto operational grid">
    <defs>
      <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <pattern id="mesh" width="50" height="50" patternUnits="userSpaceOnUse">
        <path d="M50 0H0V50" fill="none" stroke="#11111c" stroke-width="1"/></pattern>
    </defs>
    <rect width="${MW}" height="${MH}" fill="url(#mesh)"/>
    <path d="M0 ${MH * 0.78} Q ${MW * 0.3} ${MH * 0.68} ${MW * 0.55} ${MH * 0.83}
      T ${MW} ${MH * 0.72}" fill="none" stroke="#16263a" stroke-width="9" opacity=".8"/>
    <text x="16" y="${MH - 14}" class="zone-label" style="fill:#2c3d52;font-size:10px">KLIPSPRUIT RIVER</text>
    <g transform="translate(${px(27.9128)},${py(-26.2427)})">
      <path d="M-13 0 l4 -30 h18 l4 30 z" fill="#1c1c2b" stroke="#3a3a55"/>
      <path d="M13 0 l-4 -30 h-18" fill="none" stroke="#3a3a55"/>
      <text class="zone-label" y="14" text-anchor="middle" style="font-size:8px;fill:#5a5a78">ORLANDO TOWERS</text>
    </g>
    ${grid}${nodes}
    <g id="pinLayer"></g>
    <text x="${MW - 14}" y="24" text-anchor="end" class="zone-label"
      style="fill:#3a3a55;font-size:10px">SOWETO OPERATIONAL GRID · TAP TO PIN</text>
  </svg>
  <div class="map-readout" id="mapReadout">Tap anywhere to drop your intel pin.</div>`;

  $('#mapSvg').addEventListener('click', (ev) => {
    const svg = $('#mapSvg');
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * MW;
    const y = ((ev.clientY - r.top) / r.height) * MH;
    dropPin(toLat(y), toLng(x));
  });
  if (S.pin) paintPin();
}

function dropPin(lat, lng) {
  S.pin = { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
  SFX.play('pin');
  paintPin();
}

function paintPin() {
  const x = px(S.pin.lng), y = py(S.pin.lat);
  $('#pinLayer').innerHTML = `
    <g class="pin-drop" transform="translate(${x},${y})">
      <circle r="24" fill="#ff2e88" opacity=".16"/>
      <circle r="6" fill="#ff2e88" stroke="#fff" stroke-width="2"/>
      <path d="M0 -8 v-26" stroke="#ff2e88" stroke-width="2"/>
      <circle cy="-34" r="6" fill="#ff2e88"/>
    </g>`;
  // Nearest zone, computed client-side for instant feedback.
  let best = null, bestD = Infinity;
  for (const z of S.zones) {
    const d = Math.hypot((z.lat - S.pin.lat) * 111320, (z.lng - S.pin.lng) * 100000);
    if (d < bestD) { bestD = d; best = z; }
  }
  const snap = 0.00135;
  const fz = (v) => (Math.round(v / snap) * snap).toFixed(5);
  $('#mapReadout').innerHTML = `
    Pin: <b>${S.pin.lat.toFixed(5)}, ${S.pin.lng.toFixed(5)}</b> ·
    zone <b>${best.name}</b> (${Math.round(bestD)} m from ${best.landmark})<br>
    <span style="color:var(--teal)">Authorities will receive ${fz(S.pin.lat)}, ${fz(S.pin.lng)} — blurred to 150 m.</span>`;
  renderDraft();
}

$('#sevRow').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  S.severity = Number(b.dataset.sev);
  $$('#sevRow button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  SFX.play('tick');
  renderDraft();
});
$('#category').addEventListener('change', (e) => { S.category = e.target.value; renderDraft(); });
$('#toIntelBtn').addEventListener('click', () => {
  if (!S.pin) return toast('Drop a pin on the map first.');
  show('intel');
});

// ── Kasi Intel chat ───────────────────────────────────────────────────────
const CONTROL_SCRIPT = [
  { say: "Sharp sharp Msotra 👋 Control here. You're on a private line — I don't see your number.", quick: ["Cable theft happening now", "Mini-sub is broken open", "Streetlights are dead"] },
  { say: "Eish. How many people are on the scene, and are they still there?", quick: ["3 guys, still there", "They just left in a bakkie", "Nobody, just damage"] },
  { say: "Copy. Are you somewhere safe right now? Do NOT move closer.", quick: ["I'm inside my yard", "I'm across the street", "I walked away already"] },
  { say: "Good. Anything that helps the crew find it fast — a landmark, a pole number, a sound?", quick: ["Next to the transformer box", "By the taxi rank", "Loud grinding noise"] },
  { say: "Received. That's enough for City Power to roll. Add a photo if you got one safely 📸", quick: [] },
];
let scriptStep = 0;

function pushMsg(author, body, meta) {
  const el = document.createElement('div');
  el.className = `msg ${author}`;
  const time = new Date().toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = author === 'system'
    ? body
    : `${body}<time>${time}${author === 'agent' ? ' <span class="ticks">✓✓</span>' : ''}</time>`;
  $('#chat').append(el);
  $('#chat').scrollTop = $('#chat').scrollHeight;
  if (author !== 'system') S.chat.push({ author, body, ...meta });
}

function seedChat() {
  $('#chat').innerHTML = '';
  S.chat = [];
  scriptStep = 0;
  pushMsg('system', '🔒 End-to-end ghosted. Control cannot see who you are.');
  advanceControl();
}

function advanceControl() {
  const step = CONTROL_SCRIPT[Math.min(scriptStep, CONTROL_SCRIPT.length - 1)];
  setTimeout(() => {
    pushMsg('control', step.say);
    SFX.play('reply');
    $('#quickReplies').innerHTML = step.quick
      .map((q) => `<button data-q="${q.replace(/"/g, '&quot;')}">${q}</button>`).join('');
  }, 420);
}

$('#quickReplies').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) sendChat(b.dataset.q);
});
$('#chatSend').addEventListener('click', () => sendChat($('#chatInput').value));
$('#chatInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat($('#chatInput').value); });

async function sendChat(text) {
  const body = String(text || '').trim();
  if (!body) return;
  $('#chatInput').value = '';
  pushMsg('agent', body);
  SFX.play('tick');
  $('#quickReplies').innerHTML = '';
  scriptStep++;
  advanceControl();
  renderDraft();
  // Live proof that the scrubber is working on the words just typed.
  try {
    const { clean, findings } = await api('/api/ghost/preview', { body: { text: body } });
    $('#redactHint').innerHTML = findings.length
      ? `👻 Ghost Agent removed ${findings.map((f) => f.rule.replace(/_/g, ' ')).join(', ')} — authorities will read: “${clean}”`
      : '👻 Nothing identifying in that message. Clean.';
    if (findings.length) SFX.play('alert');
  } catch { /* preview is a nicety, never blocks reporting */ }
}

$('#chatInput').addEventListener('input', () => { /* placeholder for typing indicator */ });
$('#toProofBtn').addEventListener('click', () => show('proof'));

// ── Paparazzi upload ──────────────────────────────────────────────────────
const dz = $('#dropzone');
dz.addEventListener('click', () => $('#fileInput').click());
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('hot'); });
dz.addEventListener('dragleave', () => dz.classList.remove('hot'));
dz.addEventListener('drop', (e) => {
  e.preventDefault(); dz.classList.remove('hot');
  addFiles(e.dataTransfer.files);
});
$('#fileInput').addEventListener('change', (e) => addFiles(e.target.files));

function addFiles(files) {
  for (const f of [...files].slice(0, 4 - S.media.length)) {
    if (!f.type.startsWith('image/')) continue;
    const fr = new FileReader();
    fr.onload = () => {
      S.media.push(fr.result);
      SFX.play('shutter');
      renderShots();
      renderDraft();
    };
    fr.readAsDataURL(f);
  }
}

function renderShots() {
  $('#shots').innerHTML = S.media.map((src, i) => `
    <div class="shot"><img src="${src}" alt="evidence ${i + 1}">
      <button class="x" data-i="${i}" title="Remove">✕</button>
      <div class="scrub">EXIF WIPES ON SEND</div></div>`).join('');
}
$('#shots').addEventListener('click', (e) => {
  const b = e.target.closest('button.x');
  if (!b) return;
  S.media.splice(Number(b.dataset.i), 1);
  renderShots(); renderDraft();
});

function renderDraft() {
  const agentLine = S.agent ? S.agent.ghost_id : 'not enlisted';
  $('#draftSummary').innerHTML = `
    <div class="grid3" style="margin-bottom:10px">
      <div class="stat"><b>${S.pin ? '✓' : '—'}</b><span>Pin dropped</span></div>
      <div class="stat"><b>${S.chat.filter((m) => m.author === 'agent').length}</b><span>Intel lines</span></div>
      <div class="stat"><b>${S.media.length}</b><span>Photos</span></div>
    </div>
    <b>${CAT_LABEL[S.category]}</b> · severity ${S.severity}/5 · sender <span class="mono"
      style="color:var(--teal)">${agentLine}</span>`;
  $('#transmitBtn').disabled = !S.pin;
}

// ── transmit ──────────────────────────────────────────────────────────────
$('#transmitBtn').addEventListener('click', async () => {
  if (!S.pin) return toast('Drop a pin first.');
  if (!S.callsign) {
    const cs = 'Ghost' + Math.floor(Math.random() * 9000 + 1000);
    S.callsign = cs;
    localStorage.setItem('msotra.callsign', cs);
    $('#callsign').value = cs;
  }
  const btn = $('#transmitBtn');
  btn.disabled = true;
  btn.textContent = '👻 Ghosting your data…';
  showSafetyLoader();

  try {
    const res = await api('/api/reports', {
      body: {
        callsign: S.callsign, category: S.category, severity: S.severity,
        narrative: S.chat.filter((m) => m.author === 'agent').map((m) => m.body).join('. '),
        lat: S.pin.lat, lng: S.pin.lng, media: S.media, chat: S.chat,
        home_zone_id: Number($('#homeZone').value) || undefined,
      },
    });
    S.agent = res.agent;
    hideSafetyLoader();
    await proofBurst();
    renderHud();
    ghostReceipt(res);
    S.media = []; S.pin = null;
    renderShots(); seedChat(); renderMap(); renderDraft(); renderFeed();
  } catch (e) {
    hideSafetyLoader();
    toast('Transmit failed: ' + e.message, 4000);
  } finally {
    btn.disabled = false;
    btn.textContent = '⚡ Transmit to City Power / SAPS';
  }
});

let loaderEl = null;
function showSafetyLoader() {
  loaderEl = document.createElement('div');
  loaderEl.className = 'modal-wrap';
  loaderEl.innerHTML = `<div class="modal" style="text-align:center;max-width:430px">
    <div style="font-size:46px">👻</div>
    <h2 style="color:var(--amber)">Ghosting your data</h2>
    <p class="sub">Stripping EXIF & GPS · blurring your pin · redacting names & numbers ·
      building the anonymous payload.</p>
    <div class="bar" style="margin-top:14px"><i style="width:0;animation:none" id="ldBar"></i></div>
    <p class="sub" style="margin-top:16px;color:#ffd77a"><b>Real Msotra heroes report from a safe
      distance — never approach suspects.</b></p></div>`;
  document.body.append(loaderEl);
  requestAnimationFrame(() => { const b = $('#ldBar'); if (b) b.style.width = '100%'; });
}
function hideSafetyLoader() { loaderEl?.remove(); loaderEl = null; }

function proofBurst() {
  return new Promise((resolve) => {
    SFX.play('proof');
    const el = document.createElement('div');
    el.className = 'proof-burst';
    el.innerHTML = `<div class="ring"></div><div class="ring" style="animation-delay:.18s"></div>
      <div class="card"><div class="seal">✓</div><h2>Proof Uploaded</h2>
      <p>Metadata destroyed · pin blurred · identity ghosted</p></div>`;
    document.body.append(el);
    setTimeout(() => { el.remove(); resolve(); }, 1700);
  });
}

function ghostReceipt(res) {
  const g = res.ghost;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  const rules = g.text_rules_fired.length
    ? g.text_rules_fired.map((f) => `<span>${f.rule.replace(/_/g, ' ')} ×${f.hits}</span>`).join('')
    : '<span class="good">nothing identifying found</span>';
  const media = g.media_metadata_destroyed.length
    ? g.media_metadata_destroyed.map((m) => `<span>${m}</span>`).join('')
    : '<span class="good">no photo attached</span>';

  wrap.innerHTML = `<div class="modal">
    <h2>👻 Ghost Agent Receipt</h2>
    <p class="sub">Case <b class="mono" style="color:var(--amber)">${res.report.ref}</b> ·
      ${res.report.zone} (${res.report.crew}) · forwarded to
      <b>${g.forwarded_to.length ? g.forwarded_to.join(' + ').toUpperCase() : 'NOBODY — BLOCKED'}</b></p>

    <div style="margin-top:12px">
      <div class="stage"><div class="n">1</div><div><div class="t">Identity pseudonymised</div>
        <div class="d">Authorities see: <b style="color:var(--teal)">${g.agent_seen_by_authorities}</b>.
        Your callsign and ghost handle were never placed in the payload.</div></div></div>
      <div class="stage"><div class="n">2</div><div><div class="t">Narrative scrubbed</div>
        <div class="d">Rules fired on your words:</div><div class="tagrow">${rules}</div></div></div>
      <div class="stage"><div class="n">3</div><div><div class="t">Location blurred</div>
        <div class="d">Snapped to a ${g.geo.precision_m} m grid — displaced
        ${g.geo.displaced_m} m from where you stood.</div></div></div>
      <div class="stage"><div class="n">4</div><div><div class="t">Photo metadata destroyed</div>
        <div class="d">Blocks removed from your images:</div><div class="tagrow">${media}</div></div></div>
      <div class="stage"><div class="n">5</div><div><div class="t">Allowlist + tripwire</div>
        <div class="d">${g.allowlist.length} approved fields only.
        Tripwire: <b style="color:${g.tripwire.passed ? 'var(--teal)' : 'var(--danger)'}">
        ${g.tripwire.passed ? 'PASSED' : 'BLOCKED — ' + (g.tripwire.violations || []).join(', ')}</b></div></div></div>
    </div>

    <h2 style="font-size:13px;margin-top:16px;color:var(--dim)">Exactly what left the building</h2>
    <pre class="payload">${JSON.stringify(g.outbound_payload, null, 2)}</pre>

    <p class="sub" style="margin-top:14px">Pending payout on verification:
      <b style="color:var(--amber)">${res.reward_pending.coins} Msotra Coins</b>
      + ${res.reward_pending.xp} XP.</p>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
      <button class="btn teal" id="rcVerify">Simulate City Power verification</button>
      <button class="btn ghost" id="rcClose">Close</button>
    </div></div>`;
  document.body.append(wrap);
  $('#rcClose').addEventListener('click', () => wrap.remove());
  $('#rcVerify').addEventListener('click', async () => {
    wrap.remove();
    await verifyCase(res.report.ref);
  });
}

async function verifyCase(ref) {
  try {
    const v = await api('/api/verify', { body: { ref, authority: 'City Power Control' } });
    S.agent = v.agent;
    renderHud();
    SFX.play('coin');
    toast(`✅ ${ref} verified — +${v.coins} Msotra Coins`);
    if (v.rank_up || v.rank !== 'Observer') celebrateRank(v);
    renderFeed(); loadBoards();
    if ($('#view-wallet').classList.contains('active')) loadWallet();
  } catch (e) { toast(e.message, 3000); }
}

function celebrateRank(v) {
  if (!v.rank || v.rank === 'Observer') return;
  const seen = localStorage.getItem('msotra.rank') || '';
  if (seen === v.rank) return;
  localStorage.setItem('msotra.rank', v.rank);
  SFX.play('rankup');
  const el = document.createElement('div');
  el.className = 'rank-up';
  el.innerHTML = `<div class="card"><div class="b">${v.badge}</div>
    <h2>Rank up — ${v.rank}</h2><p class="sub">Soweto sees you, Msotra.</p></div>`;
  document.body.append(el);
  setTimeout(() => el.remove(), 2400);
}

// ── feed ──────────────────────────────────────────────────────────────────
async function renderFeed() {
  const { feed } = await api('/api/feed');
  $('#feed').innerHTML = feed.length ? feed.map((r) => `
    <div class="row">
      <span class="badge ${r.status}">${r.status}</span>
      <div style="flex:1;min-width:0">
        <b>${CAT_LABEL[r.category] || r.category}</b> · ${r.zone}
        <div style="color:var(--dim);font-size:11px">${r.ref} · sev ${r.severity}/5 ·
          ${r.media} photo${r.media === 1 ? '' : 's'} · anonymous</div>
      </div>
      ${r.coins_awarded ? `<b style="color:var(--amber)">+${r.coins_awarded}</b>` : ''}
    </div>`).join('') : '<p class="sub">No drops yet. Be the first Guardian tonight.</p>';
}

// ── wallet ────────────────────────────────────────────────────────────────
async function loadWallet() {
  if (!S.callsign) {
    $('#walletBalance').textContent = '0';
    $('#store').innerHTML = '<p class="sub">Enlist on the HQ tab to open a wallet.</p>';
    return;
  }
  const w = await api(`/api/wallet?callsign=${encodeURIComponent(S.callsign)}`);
  S.agent = w.agent;
  renderHud();
  $('#walletBalance').textContent = w.agent.coins;
  $('#rankFrom').textContent = `${w.agent.badge} ${w.agent.rank}`;
  $('#rankTo').textContent = w.agent.next || 'MAX';
  $('#rankBar').style.width = `${w.agent.progress}%`;
  $('#rankHint').textContent = w.agent.next
    ? `${w.agent.xp_to_next} XP to ${w.agent.next} · ${w.agent.verified} verified drops so far.`
    : 'Soweto Legend. Nothing above this.';

  $('#store').innerHTML = w.catalogue.map((c) => `
    <div class="item"><div class="ic">${c.icon}</div><div class="nm">${c.label}</div>
      <div class="px">${c.cost} MC</div>
      <button class="btn sm ${w.agent.coins >= c.cost ? '' : 'ghost'}" data-sku="${c.sku}"
        ${w.agent.coins >= c.cost ? '' : 'disabled'}>
        ${w.agent.coins >= c.cost ? 'Redeem' : `Need ${c.cost - w.agent.coins} more`}</button></div>`).join('');

  $('#ledger').innerHTML = w.ledger.length ? w.ledger.map((l) => `
    <div><span>${l.reason.replace(/_/g, ' ').replace(':', ' · ')}<br>
      <small style="color:var(--dim)">${l.created_at}</small></span>
      <span class="${l.delta > 0 ? 'plus' : 'minus'}">${l.delta > 0 ? '+' : ''}${l.delta}
      <small style="color:var(--dim);font-weight:400"> → ${l.balance_after}</small></span></div>`).join('')
    : '<p class="sub">No transactions yet.</p>';

  if (w.redemptions.length) {
    $('#voucherOut').innerHTML = w.redemptions.slice(0, 3).map((v) => `
      <div class="voucher"><b>${v.label}</b> — issued ${v.created_at}
        <div class="code mono">${v.voucher_code}</div></div>`).join('');
  }

  const { feed } = await api('/api/feed');
  const pending = feed.filter((r) => r.status === 'forwarded' || r.status === 'submitted');
  $('#pendingCases').innerHTML = pending.length ? pending.slice(0, 6).map((r) => `
    <div class="row" style="display:flex;gap:9px;align-items:center;padding:8px 0;border-bottom:1px solid #1d1d2c">
      <span class="badge ${r.status}">${r.status}</span>
      <div style="flex:1"><b>${r.ref}</b> <span style="color:var(--dim)">${r.zone} ·
        ${CAT_LABEL[r.category] || r.category}</span></div>
      <button class="btn sm teal" data-verify="${r.ref}">Verify</button>
      <button class="btn sm ghost" data-reject="${r.ref}">Reject</button>
    </div>`).join('') : '<p class="sub">No open cases. Transmit a drop first.</p>';
}

$('#store').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-sku]');
  if (!b) return;
  try {
    const r = await api('/api/redeem', { body: { callsign: S.callsign, sku: b.dataset.sku } });
    S.agent = r.agent;
    SFX.play('voucher');
    renderHud();
    toast(`${r.voucher.label} issued 🎉`);
    loadWallet();
  } catch (err) { toast(err.message, 3200); }
});

$('#pendingCases').addEventListener('click', async (e) => {
  const v = e.target.closest('button[data-verify]');
  const x = e.target.closest('button[data-reject]');
  if (v) return verifyCase(v.dataset.verify).then(loadWallet);
  if (x) {
    await api('/api/verify', { body: { ref: x.dataset.reject, outcome: 'rejected', authority: 'City Power Control' } });
    toast('Case closed as unverified — no payout.');
    loadWallet(); renderFeed();
  }
});

// ── boards ────────────────────────────────────────────────────────────────
async function loadBoards() {
  const b = await api('/api/leaderboard');
  const top = b.crews.slice(0, 2);
  $('#vsBanner').innerHTML = top.length === 2 ? `
    <div class="side"><h3>${top[0].crew}</h3><b>${top[0].score}</b>
      <small style="color:var(--dim)">${top[0].verified} verified</small></div>
    <div class="bolt">⚡VS⚡</div>
    <div class="side"><h3>${top[1].crew}</h3><b>${top[1].score}</b>
      <small style="color:var(--dim)">${top[1].verified} verified</small></div>`
    : '<div class="side"><h3>Awaiting first drops</h3></div>';

  const maxScore = Math.max(1, ...b.crews.map((c) => c.score));
  $('#crewBoard').innerHTML = b.crews.map((c, i) => `
    <tr><td><div class="pos p${i + 1}">${i + 1}</div></td>
      <td><b>${c.crew}</b><div class="bar" style="margin-top:5px">
        <i style="width:${(c.score / maxScore) * 100}%"></i></div></td>
      <td>${c.verified}/${c.reports}</td>
      <td style="color:var(--amber);font-weight:900">${c.coins}</td>
      <td style="color:${healthColour(c.grid_health)}">${c.grid_health}%</td></tr>`).join('');

  $('#zoneBoard').innerHTML = b.zones.map((z) => `
    <tr><td><b>${z.name}</b></td><td style="color:var(--dim)">${z.landmark}</td>
      <td>${z.reports}</td><td>${z.verified}</td>
      <td><div class="bar"><i style="width:${z.grid_health}%;background:${healthColour(z.grid_health)}"></i></div>
        <small style="color:var(--dim)">${z.grid_health}%</small></td></tr>`).join('');

  $('#agentBoard').innerHTML = b.agents.length ? b.agents.map((a, i) => `
    <tr class="${a.callsign === S.callsign ? 'me' : ''}">
      <td><div class="pos p${i + 1}">${i + 1}</div></td>
      <td><span class="mono">${a.ghost_id}</span>${a.callsign === S.callsign ? ' <b style="color:var(--amber)">(you)</b>' : ''}
        <div style="color:var(--dim);font-size:11px">${a.home_zone || 'unassigned'}</div></td>
      <td>${a.rank}</td><td>${a.xp}</td><td>${a.verified || 0}</td></tr>`).join('')
    : '<tr><td colspan="5" style="color:var(--dim)">No agents enlisted yet.</td></tr>';
}

// ── ghost agent tab ───────────────────────────────────────────────────────
function renderStages() {
  const stages = [
    ['Pseudonymise', 'Your callsign is replaced by an HMAC handle derived from a random nonce. Nothing in the outbound payload can be reversed to you — and the key can be destroyed, which makes the link mathematically unrecoverable.'],
    ['Scrub the text', '10 South-Africa-tuned rules strip phone numbers, ID numbers, emails, plates, house numbers, bank details, social handles, self-identification ("its me Thabo") and family references.'],
    ['Blur the geography', 'Exact pins are snapped to a 150 m grid — not jittered, so repeat reports can never be averaged back to your doorstep. Timestamps round to a 15-minute window.'],
    ['Destroy media metadata', 'JPEGs and PNGs are rebuilt byte-by-byte. APP1/EXIF (incl. GPS), APP13/IPTC, XMP, vendor blocks, comments and PNG text chunks are never copied into the new file.'],
    ['Allowlist + tripwire', 'The municipal payload is built from an empty object using 14 approved fields, then scanned one last time for any known identifier. A hit fails the send closed — a leaked payload cannot be recalled.'],
  ];
  $('#stages').innerHTML = stages.map(([t, d], i) => `
    <div class="stage"><div class="n">${i + 1}</div>
      <div><div class="t">${t}</div><div class="d">${d}</div></div></div>`).join('');
}

let scrubTimer;
$('#scrubIn').addEventListener('input', () => {
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(runScrub, 260);
});

async function runScrub() {
  const text = $('#scrubIn').value;
  const { clean, findings } = await api('/api/ghost/preview', { body: { text } });
  $('#scrubRaw').textContent = text;
  $('#scrubSafe').textContent = clean || '(nothing left)';
  $('#scrubTags').innerHTML = findings.length
    ? findings.map((f) => `<span>${f.rule.replace(/_/g, ' ')} ×${f.hits}</span>`).join('')
    : '<span class="good">clean — nothing identifying detected</span>';
}

async function loadAudit() {
  const a = await api('/api/ghost/audit');
  $('#auditOut').innerHTML = `
    <b style="color:var(--teal);font-size:16px">${a.totals.redactions}</b> redactions logged as
    evidence across all drops. Outbound allowlist: <span class="mono"
    style="color:var(--dim)">${a.allowlist.join(', ')}</span>
    ${a.summary.length ? `<table class="board" style="margin-top:10px">
      <thead><tr><th>Stage</th><th>Rule</th><th>Hits</th></tr></thead><tbody>
      ${a.summary.map((s) => `<tr><td>${s.stage}</td><td class="mono">${s.rule}</td><td>${s.hits}</td></tr>`).join('')}
      </tbody></table>` : ''}
    ${a.recent_outbound.length ? `<h2 style="font-size:12px;margin-top:14px;color:var(--dim)">
      Last payload sent to a municipality</h2>
      <pre class="payload">${JSON.stringify(a.recent_outbound[0].payload, null, 2)}</pre>` : ''}`;
}

// ── blackout escape room ──────────────────────────────────────────────────
let escTimer = null, escClues = [], escSolved = 0, escLeft = 300, escSession = null;

$('#startEscape').addEventListener('click', async () => {
  const team = $('#teamName').value.trim() || 'Team Msotra';
  const r = await api('/api/escape/start', { body: { team_name: team, zone_id: Number($('#homeZone').value) || null } });
  escSession = r.session; escClues = r.clues; escSolved = 0; escLeft = 300;
  SFX.play('blackout');
  const ov = document.createElement('div');
  ov.className = 'blackout-overlay';
  ov.innerHTML = `<div class="msg"><h1 style="font-size:34px">⚫ LIGHTS OUT</h1>
    <p>${team} — Zone 9 is dark. 5 minutes.</p></div>`;
  document.body.append(ov);
  setTimeout(() => ov.remove(), 1500);

  $('#escapeStage').hidden = false;
  renderClues();
  paintLights();
  clearInterval(escTimer);
  escTimer = setInterval(tickEscape, 1000);
  tickEscape();
});

function tickEscape() {
  escLeft--;
  const m = Math.floor(Math.max(0, escLeft) / 60), s = Math.max(0, escLeft) % 60;
  const t = $('#timer');
  t.textContent = `${m}:${String(s).padStart(2, '0')}`;
  t.classList.toggle('warn', escLeft <= 60);
  if (escLeft <= 0) endEscape(false);
}

function renderClues() {
  $('#clues').innerHTML = escClues.map((c, i) => `
    <div class="clue ${c.done ? 'solved' : ''}">
      <p><b>Clue ${i + 1}.</b> ${c.riddle}</p>
      ${c.done ? '<b style="color:var(--ok)">✓ Solved — one light back on</b>' : `
      <div class="row"><input placeholder="Answer…" data-ans="${i}">
        <button class="btn sm" data-check="${i}">Check</button></div>
      <small style="color:var(--dim)">Hint: ${c.hint}</small>`}</div>`).join('');
}

$('#clues').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-check]');
  if (!b) return;
  const i = Number(b.dataset.check);
  const given = ($(`input[data-ans="${i}"]`).value || '').toLowerCase().replace(/[\s()-]/g, '');
  if (given && escClues[i].answer.toLowerCase().includes(given) && given.length >= 4) {
    escClues[i].done = true;
    escSolved++;
    SFX.play('lights');
    paintLights();
    renderClues();
    if (escSolved === escClues.length) endEscape(true);
  } else {
    SFX.play('alert');
    toast('Not it. Look it up — that number is the point of the drill.');
  }
});
$('#clues').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.dataset.ans !== undefined) {
    $(`button[data-check="${e.target.dataset.ans}"]`)?.click();
  }
});

function paintLights() {
  $('#lights').innerHTML = escClues.map((c) => `<i class="${c.done ? 'on' : ''}"></i>`).join('');
}

async function endEscape(won) {
  clearInterval(escTimer);
  const r = await api('/api/escape/finish', {
    body: {
      id: escSession?.id, clues_found: escSolved, solved: won,
      seconds_left: Math.max(0, escLeft), callsign: S.callsign || undefined,
    },
  });
  $('#escapeBoardPanel').hidden = false;
  $('#escapeBoard').innerHTML = r.board.map((b) => `
    <tr><td><b>${b.team_name}</b></td><td>${b.clues_found}/3</td>
      <td>${b.solved ? '💡 restored' : '⚫ still dark'}</td>
      <td>${Math.floor(b.seconds_left / 60)}:${String(b.seconds_left % 60).padStart(2, '0')}</td></tr>`).join('');
  if (won) {
    SFX.play('rankup');
    toast('💡 Lights restored! +60 Msotra Coins to the team captain.', 4000);
    if (S.callsign) { const w = await api(`/api/wallet?callsign=${encodeURIComponent(S.callsign)}`); S.agent = w.agent; renderHud(); }
  } else {
    SFX.play('blackout');
    toast('Time up — Zone 9 stays dark. Run it again.', 3500);
  }
  $('#escapeStage').hidden = true;
}
$('#abortEscape').addEventListener('click', () => endEscape(false));

// ── live event stream ─────────────────────────────────────────────────────
try {
  const es = new EventSource('/events');
  es.addEventListener('report', () => { renderFeed(); });
  es.addEventListener('verified', (e) => {
    const d = JSON.parse(e.data);
    if (d.outcome === 'verified') {
      loadBoards();
      if (!$('#view-wallet').classList.contains('active')) return;
      loadWallet();
    }
  });
  es.addEventListener('leaderboard', () => {
    if ($('#view-hood').classList.contains('active')) loadBoards();
  });
} catch { /* SSE unsupported — everything still works on navigation */ }

// Rotate the safety prompt so it never becomes wallpaper.
const SAFETY_ROTATION = [
  'Real Msotra heroes report from a safe distance — never approach suspects.',
  'Never touch a cable, open chamber or transformer box. Ever.',
  'Ghost Agent is ARMED — authorities receive zero personal identifiers.',
  'If your life is in danger, stop reporting and call 10111.',
];
let sIdx = 0;
setInterval(() => {
  sIdx = (sIdx + 1) % SAFETY_ROTATION.length;
  $('#safetyText').textContent = SAFETY_ROTATION[sIdx];
}, 7000);

boot().catch((e) => {
  document.querySelector('main').insertAdjacentHTML('afterbegin',
    `<div class="panel"><h2 style="color:var(--danger)">Server unreachable</h2>
     <p class="sub">${e.message} — is <span class="mono">npm start</span> running?</p></div>`);
});
