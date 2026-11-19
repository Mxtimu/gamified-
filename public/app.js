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
  agent: null,   // the logged-in profile (session cookie), or null
  stats: null,   // live site-wide totals: drops, verified, coins_paid, players
  selfVerified: new Set(), // case refs verified from this browser (avoid double toasts)
  zones: [],
  sections: [],  // extensions / zones / phases inside each township
  area: { zoneId: null, sectionId: null }, // township + part chosen in Drop Pin
  boot: null,
  pin: null,
  category: 'cable_theft',
  severity: 3,
  chat: [],
  media: [],
  escape: null,
};

// ── map projection ────────────────────────────────────────────────────────
const LAT_TOP = -26.190, LAT_BOT = -26.300, LNG_L = 27.765, LNG_R = 27.965; // all Soweto townships
const MW = 1000, MH = 620;
const px = (lng) => ((lng - LNG_L) / (LNG_R - LNG_L)) * MW;
const py = (lat) => ((LAT_TOP - lat) / (LAT_TOP - LAT_BOT)) * MH;
const toLng = (x) => LNG_L + (x / MW) * (LNG_R - LNG_L);
const toLat = (y) => LAT_TOP - (y / MH) * (LAT_TOP - LAT_BOT);

/** Reads a theme token at runtime, so the map follows the active theme. */
const cssVar = (name) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const healthColour = (h) =>
  h >= 75 ? cssVar('--ok') : h >= 45 ? cssVar('--amber') : cssVar('--danger');
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
  if (view === 'map') requestAnimationFrame(fitStreetMap);
  if (view === 'net') loadNet();
  if (view === 'wallet') loadWallet();
  if (view === 'hood') loadBoards();
  if (view === 'ghost') { renderStages(); loadAudit(); runScrub(); }
  if (view === 'proof') renderDraft();
}
$$('nav.tabs button').forEach((b) => b.addEventListener('click', () => { SFX.play('tick'); show(b.dataset.view); }));

$('#muteBtn').addEventListener('click', (e) => {
  e.target.textContent = SFX.toggle() ? '🔊 SFX' : '🔇 SFX';
});

// ── theme: night ops (default) ⇄ daylight ───────────────────────────────
// Dark is the brand identity. Daylight Mode exists because agents report
// outdoors in hard sun, where a dark screen is genuinely unreadable.
const THEME_KEY = 'msotra.theme';
const activeTheme = () =>
  document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';

function applyTheme(theme) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch { /* private mode */ }

  const btn = $('#themeBtn');
  btn.textContent = light ? '🌙 Night Ops' : '☀️ Daylight';
  btn.setAttribute('aria-pressed', String(light));
  btn.title = light ? 'Switch back to night ops (dark)' : 'Switch to daylight mode (light)';
  $('#themeColor')?.setAttribute('content', light ? '#f5f3ef' : '#08080d');

  // The map reads its fills from theme tokens at paint time, so redraw it.
  if (S.zones.length) renderMap();
}

$('#themeBtn').addEventListener('click', () => {
  SFX.play('tick');
  applyTheme(activeTheme() === 'light' ? 'dark' : 'light');
});

// Sync the button with whatever the pre-paint script in index.html applied.
applyTheme(activeTheme());

// ── bootstrap ─────────────────────────────────────────────────────────────
async function boot() {
  try { localStorage.removeItem('msotra.callsign'); } catch { /* legacy key, pre-profiles */ }
  S.boot = await api('/api/bootstrap');
  S.zones = S.boot.zones;
  S.sections = S.boot.sections || [];
  S.agent = S.boot.agent;
  S.stats = S.boot.stats;

  $('#homeZone').innerHTML = zoneOptions();
  $('#registerAvatars').insertAdjacentHTML('beforeend', avatarPicker('reg', S.boot.avatars[0]));

  $('#safetyText').textContent = S.boot.safety.prompt;
  $('#safetyRules').innerHTML = S.boot.safety.rules.map((r) => `<li>${r}</li>`).join('');
  $('#hotlines').innerHTML = S.boot.hotline.map((h) => `
    <div class="stat"><span>${h.name}</span><b style="font-size:17px">${h.number}</b></div>`).join('');

  renderHud();
  renderAreaPicker();
  renderMap();
  renderFeed();
  seedChat();
  renderHqStats();
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const zoneOptions = () => '<option value="">Choose your turf…</option>' + [...S.zones]
  .sort((a, b) => a.name.localeCompare(b.name)).map((z) => `<option value="${z.id}">${esc(z.name)} — ${esc(z.landmark)}</option>`).join('');
const avatarPicker = (name, selected) => S.boot.avatars.map((av) => `
  <label class="av"><input type="radio" name="${name}-avatar" value="${av}" ${av === selected ? 'checked' : ''}>
    <span>${av}</span></label>`).join('');

function renderHud() {
  const a = S.agent;
  $('#ghostId').textContent = a ? a.ghost_id : 'CREATE PROFILE';
  $('#hudAvatar').textContent = a ? a.avatar : '👤';
  $('#rankName').textContent = a ? `${a.badge} ${a.rank}` : 'Observer';
  $('#coinCount').textContent = a ? a.coins : 0;
  $('#hqProfile').innerHTML = a
    ? `<h2>Welcome back, ${a.avatar} ${esc(a.callsign)} <span class="tag">ENLISTED</span></h2>
       <p class="sub">Authorities will only ever see <b class="mono" style="color:var(--teal-text)">${a.ghost_id}</b>
       — never your callsign, never your number. Every verified report pays <b>10 Msotra Coins</b>, automatically.</p>`
    : `<h2>Agent Setup <span class="tag">NO REAL NAMES</span></h2>
       <p class="sub">Create your profile to start dropping intel. One profile per person.
       Every verified report pays <b>10 Msotra Coins</b>, automatically.</p>
       <button class="btn teal" type="button" data-goto="profile">Create profile / Log in</button>`;
  renderProfile();
}

/** Site-wide totals: header chip + HQ cards. Pushed live over SSE. */
function renderStats() {
  const s = S.stats || { drops: 0, verified: 0, coins_paid: 0 };
  $('#dropCount').textContent = s.drops;
  $('#verifiedCount').textContent = s.verified;
  $('#hqStats').innerHTML = `
    <div class="stat"><b>${s.drops}</b><span>Total intel drops</span></div>
    <div class="stat"><b>${s.verified}</b><span>Verified by authorities</span></div>
    <div class="stat"><b>${s.coins_paid}</b><span>Msotra Coins paid out</span></div>`;
}
const renderHqStats = renderStats;

$('#chipGhost').addEventListener('click', () => show('profile'));
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goto]');
  if (g) show(g.dataset.goto);
});

// ── profile ───────────────────────────────────────────────────────────────
function renderProfile() {
  const a = S.agent;
  // First visit (or logged out): nothing is playable until the agent has an ID.
  // The same sign-up / log-in form is moved into a full-screen gate.
  $('#gate').hidden = !!a;
  document.body.classList.toggle('gated', !a);
  (a ? $('#view-profile') : $('#gateSlot')).prepend($('#authPanel'));
  if (!a) setTimeout(() => $('#authPanel input:not([type=radio])')?.focus(), 50);
  $('#authPanel').hidden = !!a;
  $('#profileCard').hidden = !a;
  if (!a) return;
  $('#profileCard').innerHTML = `
    <div class="profile-head">
      <div class="profile-avatar" aria-hidden="true">${a.avatar}</div>
      <div class="profile-id">
        <h2>${esc(a.callsign)}</h2>
        <div class="sub">Ghost handle <b class="mono" style="color:var(--teal-text)">${a.ghost_id}</b>
          · joined ${esc(String(a.joined).slice(0, 10))}</div>
      </div>
      <button class="btn sm ghost" id="logoutBtn" type="button">Log out</button>
    </div>
    <p class="sub" style="margin:14px 0 6px">${a.badge} <b>${a.rank}</b> · ${a.xp} XP
      ${a.next ? `· ${a.xp_to_next} XP to ${a.next}` : '· top rank'}</p>
    <div class="bar"><i style="width:${a.progress}%"></i></div>
    <div class="grid3" style="margin-top:14px">
      <div class="stat"><b>${a.reports}</b><span>My drops</span></div>
      <div class="stat"><b>${a.verified}</b><span>Verified</span></div>
      <div class="stat"><b>${a.coins}</b><span>Msotra Coins</span></div>
    </div>
    <div class="grid2" style="margin-top:14px">
      <label class="fld"><span>Home turf</span><select id="profileZone">${zoneOptions()}</select></label>
    </div>
    <fieldset class="avatar-pick"><legend>Avatar</legend>${avatarPicker('prof', a.avatar)}</fieldset>
    <p class="sub">Authorities only ever see <b>${a.ghost_id}</b> — never your callsign, never your number.</p>`;
  $('#profileZone').value = a.home_zone_id ?? '';
}

function authError(msg) {
  $('#authError').hidden = !msg;
  $('#authError').textContent = msg || '';
}

function signedIn(agent, msg) {
  S.agent = agent;
  NET.items.clear(); NET.open.clear(); // "mine" and my reactions are per agent
  authError('');
  SFX.play('rankup');
  renderHud();
  toast(msg);
}

$('#authPanel').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-auth]');
  if (!b) return;
  $$('[data-auth]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  $('#registerForm').hidden = b.dataset.auth !== 'register';
  $('#loginForm').hidden = b.dataset.auth !== 'login';
  authError('');
});

$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const v = (n) => f.elements[n].value.trim();
  if (!/^[A-Za-z0-9_.-]{3,24}$/.test(v('callsign'))) {
    return authError('Callsign must be 3–24 letters, numbers, dots, dashes or underscores.');
  }
  if (!/^\d{4,8}$/.test(v('pin'))) return authError('PIN must be 4–8 digits.');
  if (v('pin') !== v('pin2')) return authError("The two PINs don't match.");
  try {
    const { agent } = await api('/api/register', {
      body: {
        callsign: v('callsign'), phone: v('phone'), pin: v('pin'),
        home_zone_id: Number(v('home_zone_id')) || null,
        avatar: f.querySelector('input[name="reg-avatar"]:checked')?.value,
      },
    });
    f.reset();
    signedIn(agent, `Welcome, ${agent.ghost_id}. Ghost Agent armed.`);
  } catch (err) { authError(err.message); }
});

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    const { agent } = await api('/api/login', {
      body: { callsign: f.elements.callsign.value.trim(), pin: f.elements.pin.value.trim() },
    });
    f.reset();
    signedIn(agent, `Welcome back, ${agent.ghost_id}.`);
  } catch (err) { authError(err.message); }
});

$('#profileCard').addEventListener('click', async (e) => {
  if (!e.target.closest('#logoutBtn')) return;
  await api('/api/logout', { body: {} });
  S.agent = null;
  NET.items.clear(); NET.open.clear();
  renderHud();
  toast('Logged out.');
});

$('#profileCard').addEventListener('change', async (e) => {
  const body = e.target.id === 'profileZone' ? { home_zone_id: Number(e.target.value) || null }
    : e.target.name === 'prof-avatar' ? { avatar: e.target.value } : null;
  if (!body) return;
  try {
    S.agent = (await api('/api/profile', { body })).agent;
    renderHud();
    toast('Profile saved.');
  } catch (err) { toast(err.message, 3000); }
});

/** Re-reads my profile; toasts if coins arrived from a verification elsewhere. */
async function refreshMe(ref) {
  if (!S.agent) return;
  const before = S.agent.coins;
  try { S.agent = (await api('/api/me')).agent; } catch { S.agent = null; }
  renderHud();
  if (S.agent && S.agent.coins > before && !S.selfVerified.has(ref)) {
    SFX.play('coin');
    toast(`🪙 +${S.agent.coins - before} Msotra Coins — one of your reports was verified!`, 3500);
  }
}

// ── map ───────────────────────────────────────────────────────────────────
// Two looks: an OpenStreetMap street map (default, tiles proxied + cached by
// our own server so OSM never sees the reporter) and the stylised SVG grid,
// which needs no network and is the automatic fallback when offline.
const MAP_MODE_KEY = 'msotra.mapMode';
const SOWETO_BOUNDS = [[LAT_BOT, LNG_L], [LAT_TOP, LNG_R]];
let mapMode = (() => { try { return localStorage.getItem(MAP_MODE_KEY); } catch { return null; } })() || 'street';
let osm = null; // { map, zones, pin, needsFit }

function renderMap() {
  $$('#mapToggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mapMode)));
  if (mapMode === 'street' && window.L) return renderStreetMap();
  if (osm) { osm.map.remove(); osm = null; }
  renderGridMap();
}

$('#mapToggle').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mode]');
  if (!b || b.dataset.mode === mapMode) return;
  if (b.dataset.mode === 'street' && !window.L) return toast('Street map failed to load — using the grid.');
  mapMode = b.dataset.mode;
  try { localStorage.setItem(MAP_MODE_KEY, mapMode); } catch { /* private mode */ }
  SFX.play('tick');
  renderMap();
});

function fallbackToGrid() {
  if (mapMode !== 'street') return;
  mapMode = 'grid'; // not persisted: next visit tries the street map again
  toast('No connection for street tiles — switched to the offline Soweto grid.', 3500);
  renderMap();
}

function renderStreetMap() {
  if (!osm || !document.getElementById('osm')) {
    $('#mapWrap').innerHTML = `
      <div id="osm" class="osm" aria-label="Soweto street map — tap to drop your pin"></div>
      <div class="map-readout" id="mapReadout">Tap anywhere to drop your intel pin.</div>`;
    const map = L.map('osm', {
      minZoom: 11, maxZoom: 18,
      maxBounds: [[-26.34, 27.72], [-26.15, 28.03]], maxBoundsViscosity: 1,
    });
    const tiles = L.tileLayer('/tiles/{z}/{x}/{y}.png', {
      minZoom: 11, maxZoom: 18,
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    }).addTo(map);
    let loaded = 0, failed = 0;
    tiles.on('tileload', () => { loaded++; });
    tiles.on('tileerror', () => { if (++failed >= 4 && !loaded) fallbackToGrid(); });
    map.on('click', (e) => dropPin(e.latlng.lat, e.latlng.lng));
    osm = { map, zones: L.layerGroup().addTo(map), pin: L.layerGroup().addTo(map), needsFit: true };
    fitStreetMap();
  }

  osm.zones.clearLayers();
  for (const z of S.zones) {
    L.circleMarker([z.lat, z.lng], {
      radius: 8 + Math.min(6, z.reports), weight: 2,
      color: cssVar('--map-node-line') || '#000', fillColor: healthColour(z.grid_health), fillOpacity: 0.9,
      className: (z.grid_health < 45 ? 'osm-zone hot' : 'osm-zone') + (z.id === S.area.zoneId ? ' chosen' : ''),
    }).bindTooltip(`<b>${esc(z.name)}</b><br>${z.grid_health}% grid · ${z.reports} drops`, { direction: 'top' })
      .addTo(osm.zones);
  }
  if (S.pin) paintPin(); else osm.pin.clearLayers();
}

/** Leaflet can't size itself inside a hidden tab, so fit once the map tab is visible. */
function fitStreetMap() {
  if (!osm || !osm.needsFit || !$('#osm').offsetWidth) return;
  osm.map.invalidateSize();
  osm.map.fitBounds(SOWETO_BOUNDS);
  osm.needsFit = false;
}

function renderGridMap() {
  // Power lines: join every township to its two nearest neighbours.
  const seen = new Set();
  const links = [];
  for (const A of S.zones) {
    const near = S.zones.filter((B) => B !== A)
      .sort((p, q) => metres(A.lat, A.lng, p.lat, p.lng) - metres(A.lat, A.lng, q.lat, q.lng)).slice(0, 2);
    for (const B of near) {
      const key = [A.id, B.id].sort((x, y) => x - y).join('-');
      if (!seen.has(key)) { seen.add(key); links.push([A, B]); }
    }
  }

  const grid = links.map(([A, B]) => {
    return `<line x1="${px(A.lng)}" y1="${py(A.lat)}" x2="${px(B.lng)}" y2="${py(B.lat)}"
      class="map-link" stroke-width="2" stroke-dasharray="7 6"/>`;
  }).join('');

  const nodes = S.zones.map((z) => {
    const x = px(z.lng), y = py(z.lat), c = healthColour(z.grid_health);
    const hot = z.grid_health < 45;
    const chosen = z.id === S.area.zoneId;
    return `<g class="zone-hit${chosen ? ' chosen' : ''}" data-zone="${z.id}" data-lat="${z.lat}" data-lng="${z.lng}">
      <title>${esc(z.name)} — ${z.grid_health}% grid · ${z.reports} drops</title>
      ${hot ? `<circle cx="${x}" cy="${y}" r="7" fill="${c}" opacity=".5" class="pulse"/>` : ''}
      <circle class="zone-node" cx="${x}" cy="${y}" r="${(chosen ? 10 : 6) + Math.min(5, z.reports)}"
        fill="${c}" opacity=".9" stroke-width="${chosen ? 4 : 2}"/>
      <text class="zone-label" x="${x}" y="${y - 11}" text-anchor="middle"
        font-size="${chosen ? 14 : 10}">${esc(z.name)}</text>
    </g>`;
  }).join('');

  $('#mapWrap').innerHTML = `
  <svg viewBox="0 0 ${MW} ${MH}" id="mapSvg" role="img" aria-label="Soweto operational grid">
    <defs>
      <filter id="glow"><feGaussianBlur stdDeviation="5" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      <pattern id="mesh" width="50" height="50" patternUnits="userSpaceOnUse">
        <path d="M50 0H0V50" fill="none" class="map-mesh-line" stroke-width="1"/></pattern>
    </defs>
    <rect width="${MW}" height="${MH}" class="map-canvas"/>
    <rect width="${MW}" height="${MH}" fill="url(#mesh)"/>
    <path d="M0 ${MH * 0.78} Q ${MW * 0.3} ${MH * 0.68} ${MW * 0.55} ${MH * 0.83}
      T ${MW} ${MH * 0.72}" fill="none" class="map-river" stroke-width="9" opacity=".8"/>
    <text x="16" y="${MH - 14}" class="zone-label map-river-label">KLIPSPRUIT RIVER</text>
    <g transform="translate(${px(27.9128)},${py(-26.2427)})">
      <path d="M-13 0 l4 -30 h18 l4 30 z" class="map-tower"/>
      <path d="M13 0 l-4 -30 h-18" fill="none" class="map-tower-line"/>
      <text class="zone-label map-tower-label" y="14" text-anchor="middle">ORLANDO TOWERS</text>
    </g>
    ${grid}${nodes}
    <g id="pinLayer"></g>
    <text x="${MW - 14}" y="24" text-anchor="end" class="zone-label map-hint">SOWETO OPERATIONAL GRID · TAP TO PIN</text>
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
  // No township picked yet, or the pin landed outside the picked one: use the nearest.
  const chosen = zoneById(S.area.zoneId);
  if (!chosen || metres(chosen.lat, chosen.lng, S.pin.lat, S.pin.lng) > TOWNSHIP_RADIUS_M) {
    const near = nearestTownship(S.pin.lat, S.pin.lng);
    if (near) { setTownship(near.id, { fly: false }); return; } // setTownship repaints the pin
  }
  paintPin();
}

const PIN_SVG = `
      <circle r="24" class="pin-halo"/>
      <circle r="6" class="pin-dot"/>
      <path d="M0 -8 v-26" class="pin-stem"/>
      <circle cy="-34" r="6" class="pin-head"/>`;

function paintPin() {
  const snap = 0.00135;
  if (osm) {
    // Show the 150 m cell authorities receive, so the blur is visible on real streets.
    const cLat = Math.round(S.pin.lat / snap) * snap, cLng = Math.round(S.pin.lng / snap) * snap;
    osm.pin.clearLayers();
    L.rectangle([[cLat - snap / 2, cLng - snap / 2], [cLat + snap / 2, cLng + snap / 2]], {
      className: 'osm-blur', weight: 2, dashArray: '6 5', fillOpacity: 0.12, interactive: false,
    }).addTo(osm.pin);
    L.marker([S.pin.lat, S.pin.lng], {
      interactive: false, keyboard: false,
      icon: L.divIcon({
        className: 'osm-pin', iconSize: [60, 80], iconAnchor: [30, 50],
        html: `<svg width="60" height="80" viewBox="-30 -50 60 80"><g class="pin-drop">${PIN_SVG}</g></svg>`,
      }),
    }).addTo(osm.pin);
  } else {
    $('#pinLayer').innerHTML = `
    <g class="pin-drop" transform="translate(${px(S.pin.lng)},${py(S.pin.lat)})">${PIN_SVG}</g>`;
  }
  const best = zoneById(S.area.zoneId) || nearestTownship(S.pin.lat, S.pin.lng);
  const bestD = metres(best.lat, best.lng, S.pin.lat, S.pin.lng);
  const fz =(v) => (Math.round(v / snap) * snap).toFixed(5);
  $('#mapReadout').innerHTML = `
    Pin: <b>${S.pin.lat.toFixed(5)}, ${S.pin.lng.toFixed(5)}</b> ·
    <b>${esc(areaLabel() || best.name)}</b> (${Math.round(bestD)} m from ${esc(best.landmark)})
    ${S.area.sectionId ? '' : '<br><span style="color:var(--dim)">Pick the extension / zone above to be exact.</span>'}<br>
    <span style="color:var(--teal-text)">Authorities will receive ${fz(S.pin.lat)}, ${fz(S.pin.lng)} — blurred to 150 m.</span>`;
  renderDraft();
}

// ── township → extension / zone picker ────────────────────────────────────
const TOWNSHIP_RADIUS_M = 4000; // same rule as the server's resolveArea()
const zoneById = (id) => S.zones.find((z) => z.id === id) || null;
const sectionsOf = (zoneId) => S.sections.filter((s) => s.zone_id === zoneId);

/** Great-circle distance in metres. */
function metres(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = (d) => (d * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lng2 - lng1) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function nearestTownship(lat, lng) {
  let best = null, bestD = Infinity;
  for (const z of S.zones) {
    const d = metres(z.lat, z.lng, lat, lng);
    if (d < bestD) { bestD = d; best = z; }
  }
  return best;
}

/** "Meadowlands · Zone 9", or just "Protea Glen Ext 12" when the part already names the township. */
function placeLabel(zone, section) {
  if (!zone) return '';
  if (!section) return zone;
  return section.toLowerCase().startsWith(zone.toLowerCase()) ? section : `${zone} · ${section}`;
}
function areaLabel() {
  const z = zoneById(S.area.zoneId);
  if (!z) return null;
  return placeLabel(z.name, S.sections.find((s) => s.id === S.area.sectionId)?.name);
}

function renderAreaPicker() {
  const q = $('#townshipSearch').value.trim().toLowerCase();
  const list = [...S.zones]
    .sort((a, b) => a.name.localeCompare(b.name))
    .filter((z) => !q || z.name.toLowerCase().includes(q) ||
      sectionsOf(z.id).some((s) => s.name.toLowerCase().includes(q)));
  $('#townshipList').innerHTML = list.length
    ? list.map((z) => `<button type="button" role="option" data-zone="${z.id}"
        aria-selected="${z.id === S.area.zoneId}">${esc(z.name)}</button>`).join('')
    : '<span class="none">No township matches that. Drop a pin on the map instead.</span>';

  const z = zoneById(S.area.zoneId);
  $('#sectionBlock').hidden = !z;
  if (!z) return;
  $('#sectionTitle').innerHTML = `2 · Which part of <b>${esc(z.name)}</b>?`;
  $('#sectionList').innerHTML = sectionsOf(z.id).map((s) => `
    <button type="button" role="option" data-section="${s.id}"
      aria-selected="${s.id === S.area.sectionId}">${esc(s.name)}</button>`).join('') +
    `<button type="button" role="option" class="unsure" data-section=""
      aria-selected="${S.area.sectionId === null}">Not sure</button>`;
}

function setTownship(zoneId, { fly = true } = {}) {
  const z = zoneById(zoneId);
  if (!z) return;
  if (S.area.zoneId !== zoneId) S.area = { zoneId, sectionId: null };
  // A pin left behind in another township would contradict the choice.
  if (S.pin && metres(z.lat, z.lng, S.pin.lat, S.pin.lng) > TOWNSHIP_RADIUS_M) S.pin = null;
  renderAreaPicker();
  renderMap();
  if (fly) {
    if (osm) osm.map.flyTo([z.lat, z.lng], 15, { duration: 0.8 });
    if (!S.pin && $('#mapReadout')) {
      $('#mapReadout').innerHTML = `<b>${esc(z.name)}</b> — now tap the exact spot on the map.`;
    }
  }
  if (S.pin) paintPin(); else renderDraft();
}

$('#townshipSearch').addEventListener('input', renderAreaPicker);
$('#townshipList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-zone]');
  if (!b) return;
  SFX.play('tick');
  setTownship(Number(b.dataset.zone));
});
$('#sectionList').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-section]');
  if (!b) return;
  SFX.play('tick');
  S.area.sectionId = b.dataset.section ? Number(b.dataset.section) : null;
  renderAreaPicker();
  if (S.pin) paintPin(); else renderDraft();
});

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
$('#fileInput').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

// Each photo is analysed and cleaned ON THIS DEVICE before it is ever sent:
//  1. read the hidden metadata (GPS, phone model, time taken) so we can show it,
//  2. decode + redraw it on a canvas — the redraw carries no metadata at all,
//     converts HEIC/WebP to JPEG where the browser can read them, and shrinks
//     multi-MB phone photos to ~300 KB so four of them fit in one upload,
//  3. measure brightness + sharpness so the agent knows if it's usable evidence.
// The server still strips metadata again (Ghost Agent stage 4) — belt and braces.
const MAX_PHOTOS = 4;
const MAX_SIDE = 1600;

async function addFiles(files) {
  const room = MAX_PHOTOS - S.media.length;
  if (room <= 0) return toast(`Max ${MAX_PHOTOS} photos per report.`);
  for (const f of [...files].slice(0, room)) {
    if (!f.type.startsWith('image/') && !/\.(heic|heif)$/i.test(f.name)) {
      toast(`"${f.name}" isn't a photo.`);
      continue;
    }
    const item = { id: Math.random().toString(36).slice(2), busy: true, src: null, analysis: null };
    S.media.push(item);
    renderShots(); renderDraft();
    try {
      Object.assign(item, await processPhoto(f), { busy: false });
      SFX.play('shutter');
    } catch (err) {
      S.media = S.media.filter((m) => m !== item);
      toast(err.message, 5000);
    }
    renderShots(); renderDraft();
  }
}

async function processPhoto(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const meta = readPhotoMetadata(bytes);
  let bmp;
  try {
    bmp = await createImageBitmap(file); // applies EXIF rotation, so the redraw is upright
  } catch {
    throw new Error(`Couldn't open "${file.name}" on this device${meta.format === 'HEIC' ? ' (iPhone HEIC photo)' : ''}. `
      + 'Use the camera button, or pick a JPG or PNG.');
  }
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
  const src = canvas.toDataURL('image/jpeg', 0.85);
  const quality = measureQuality(bmp);
  const analysis = {
    ...meta, ...quality,
    width: bmp.width, height: bmp.height, outW: w, outH: h,
    bytesIn: file.size, bytesOut: Math.round(((src.length - src.indexOf(',') - 1) * 3) / 4),
  };
  bmp.close?.();
  return { src, analysis };
}

/** Mean brightness (0–255) and sharpness (variance of the Laplacian) on a small copy. */
function measureQuality(bmp) {
  const s = Math.min(1, 256 / Math.max(bmp.width, bmp.height));
  const w = Math.max(3, Math.round(bmp.width * s)), h = Math.max(3, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  let sum = 0;
  for (let i = 0; i < w * h; i++) {
    g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    sum += g[i];
  }
  let n = 0, mean = 0, m2 = 0; // Welford's running variance
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const lap = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
      n++; const delta = lap - mean; mean += delta / n; m2 += delta * (lap - mean);
    }
  }
  return { brightness: Math.round(sum / (w * h)), sharpness: Math.round(n > 1 ? m2 / (n - 1) : 0) };
}

// ── photo metadata reader (JPEG EXIF + PNG eXIf/text; HEIC/WebP detected) ──
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function readPhotoMetadata(b) {
  const out = { format: 'unknown', gps: null, make: null, model: null, taken: null, software: null, blocks: [] };
  if (b[0] === 0xff && b[1] === 0xd8) {
    out.format = 'JPEG';
    let i = 2;
    while (i + 4 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const mk = b[i + 1];
      if (mk === 0xda || mk === 0xd9) break; // image data starts: no more metadata
      if (mk === 0xd8 || mk === 0x01 || (mk >= 0xd0 && mk <= 0xd7)) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (mk === 0xe1 && ascii(b, i + 4, 4) === 'Exif') { out.blocks.push('EXIF'); parseTiff(b, i + 10, out); }
      else if (mk === 0xe1 && ascii(b, i + 4, 20).startsWith('http://ns.adobe.com')) out.blocks.push('XMP');
      else if (mk === 0xed) out.blocks.push('IPTC');
      else if (mk === 0xfe) out.blocks.push('Comment');
      i += 2 + len;
    }
  } else if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') {
    out.format = 'PNG';
    let i = 8;
    while (i + 8 <= b.length) {
      const len = ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
      const type = ascii(b, i + 4, 4);
      if (type === 'eXIf') { out.blocks.push('EXIF'); parseTiff(b, i + 8, out); }
      else if (/^(tEXt|iTXt|zTXt)$/.test(type) && !out.blocks.includes('Text')) out.blocks.push('Text');
      if (type === 'IEND') break;
      i += 12 + len;
    }
  } else if (ascii(b, 4, 4) === 'ftyp' && /hei|mif|hev/.test(ascii(b, 8, 4))) out.format = 'HEIC';
  else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') out.format = 'WebP';
  return out;
}

/** Minimal TIFF/EXIF walker: make, model, software, time taken, GPS position. */
function parseTiff(b, t, out) {
  try {
    const le = b[t] === 0x49; // 'II' little-endian, 'MM' big-endian
    const u16 = (o) => (le ? b[t + o] | (b[t + o + 1] << 8) : (b[t + o] << 8) | b[t + o + 1]);
    const u32 = (o) => (le
      ? b[t + o] + (b[t + o + 1] << 8) + (b[t + o + 2] << 16) + b[t + o + 3] * 16777216
      : b[t + o] * 16777216 + (b[t + o + 1] << 16) + (b[t + o + 2] << 8) + b[t + o + 3]);
    const SIZES = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const ifd = (off) => {
      const tags = {};
      const n = Math.min(u16(off), 300);
      for (let k = 0; k < n; k++) {
        const e = off + 2 + k * 12;
        const type = u16(e + 2), cnt = u32(e + 4);
        tags[u16(e)] = { type, cnt, vo: (SIZES[type] || 1) * cnt <= 4 ? e + 8 : u32(e + 8) };
      }
      return tags;
    };
    const str = (x) => {
      let s = '';
      for (let k = 0; k < Math.min(x.cnt, 120) && b[t + x.vo + k]; k++) s += String.fromCharCode(b[t + x.vo + k]);
      return s.trim() || null;
    };
    const num = (x) => (x.type === 3 ? u16(x.vo) : u32(x.vo));
    const rat = (o) => u32(o) / (u32(o + 4) || 1);

    const ifd0 = ifd(u32(4));
    if (ifd0[0x10f]) out.make = str(ifd0[0x10f]);
    if (ifd0[0x110]) out.model = str(ifd0[0x110]);
    if (ifd0[0x131]) out.software = str(ifd0[0x131]);
    if (ifd0[0x8769]) {
      const ex = ifd(num(ifd0[0x8769]));
      if (ex[0x9003]) out.taken = str(ex[0x9003]);
    }
    if (!out.taken && ifd0[0x132]) out.taken = str(ifd0[0x132]);
    if (ifd0[0x8825]) {
      const gp = ifd(num(ifd0[0x8825]));
      if (gp[2] && gp[4]) {
        const dms = (x) => rat(x.vo) + rat(x.vo + 8) / 60 + rat(x.vo + 16) / 3600;
        let lat = dms(gp[2]), lng = dms(gp[4]);
        if (gp[1] && str(gp[1]) === 'S') lat = -lat;
        if (gp[3] && str(gp[3]) === 'W') lng = -lng;
        if (Number.isFinite(lat) && Number.isFinite(lng) && (lat || lng)) out.gps = { lat, lng };
      }
    }
  } catch { /* malformed EXIF: irrelevant, the canvas redraw drops it all anyway */ }
}

/** Turns measurements into a verdict + plain-language findings. */
function photoVerdict(a) {
  const issues = [];
  if (a.brightness < 45) issues.push(['bad', '🌑', 'Very dark — hard for City Power to see the damage.']);
  else if (a.brightness > 225) issues.push(['warn', '☀️', 'Very bright / washed out.']);
  if (a.sharpness < 40) issues.push(['bad', '🌫️', 'Blurry — hold still or lean on something.']);
  else if (a.sharpness < 110) issues.push(['warn', '🔍', 'A little soft, details may be hard to read.']);
  if (Math.min(a.width, a.height) < 480) issues.push(['warn', '📐', 'Low resolution.']);
  const bad = issues.some(([lvl]) => lvl === 'bad');
  return {
    level: bad ? 'bad' : issues.length ? 'warn' : 'ok',
    label: bad ? 'Weak evidence' : issues.length ? 'Usable evidence' : 'Strong evidence',
    issues,
  };
}

const kb = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

function renderShots() {
  $('#shots').innerHTML = S.media.map((m, i) => {
    if (m.busy) {
      return `<div class="shot-card"><div class="shot shot-busy">🔍</div>
        <div class="analysis"><b>Analysing photo ${i + 1}…</b>
        <p class="sub">Finding hidden data and checking quality, on this phone.</p></div></div>`;
    }
    const a = m.analysis, v = photoVerdict(a);
    const removed = [
      a.gps ? `<li class="hit">🛰️ <b>GPS location</b> where you stood
        (<span class="mono">${a.gps.lat.toFixed(5)}, ${a.gps.lng.toFixed(5)}</span>) → <b>removed</b></li>`
        : '<li>🛰️ No GPS location inside this photo</li>',
      (a.make || a.model) ? `<li class="hit">📱 Phone model “${esc([a.make, a.model].filter(Boolean).join(' '))}” → <b>removed</b></li>` : '',
      a.taken ? `<li class="hit">🕒 Exact time taken (${esc(a.taken)}) → <b>removed</b></li>` : '',
      a.software ? `<li class="hit">⚙️ Software “${esc(a.software)}” → <b>removed</b></li>` : '',
      a.blocks.filter((x) => x !== 'EXIF').length
        ? `<li class="hit">🧾 Hidden ${a.blocks.filter((x) => x !== 'EXIF').join(', ')} data → <b>removed</b></li>` : '',
    ].join('');
    const inPins = a.gps && a.gps.lat < LAT_TOP && a.gps.lat > LAT_BOT && a.gps.lng > LNG_L && a.gps.lng < LNG_R;
    return `<div class="shot-card">
      <div class="shot"><img src="${m.src}" alt="Evidence photo ${i + 1}">
        <button class="x" data-id="${m.id}" title="Remove photo" aria-label="Remove photo ${i + 1}">✕</button>
        <div class="scrub">METADATA REMOVED</div></div>
      <div class="analysis">
        <div class="verdict ${v.level}">${v.level === 'ok' ? '✅' : v.level === 'warn' ? '🟡' : '⚠️'} ${v.label}</div>
        <ul>${removed}
          ${v.issues.map(([lvl, icon, text]) => `<li class="q-${lvl}">${icon} ${text}</li>`).join('')
            || '<li class="q-ok">👌 Bright and sharp enough to read</li>'}
          <li class="dim">${a.format} ${a.width}×${a.height}, ${kb(a.bytesIn)} → sends as ${a.outW}×${a.outH}, ${kb(a.bytesOut)}</li>
        </ul>
        ${v.level === 'bad' ? '<p class="sub q-note">Only retake it if you can do so <b>from cover</b>. A weak photo plus good intel still helps.</p>' : ''}
        ${inPins && !S.pin ? `<button class="btn sm ghost" type="button" data-usegps="${m.id}">📍 Use where this was taken as my pin</button>` : ''}
      </div></div>`;
  }).join('');
}
$('#shots').addEventListener('click', (e) => {
  const x = e.target.closest('button.x');
  if (x) {
    S.media = S.media.filter((m) => m.id !== x.dataset.id);
    renderShots(); renderDraft();
    return;
  }
  const g = e.target.closest('button[data-usegps]');
  if (g) {
    const { gps } = S.media.find((m) => m.id === g.dataset.usegps).analysis;
    dropPin(gps.lat, gps.lng); // stays on our server; authorities get the 150 m cell
    renderShots();
    toast('Pin dropped where the photo was taken. Authorities only get a 150 m area.', 3500);
  }
});

function renderDraft() {
  const agentLine = S.agent ? S.agent.ghost_id : 'not enlisted';
  $('#draftSummary').innerHTML = `
    <div class="grid3" style="margin-bottom:10px">
      <div class="stat"><b>${S.pin ? '✓' : '—'}</b><span>Pin dropped</span></div>
      <div class="stat"><b>${S.chat.filter((m) => m.author === 'agent').length}</b><span>Intel lines</span></div>
      <div class="stat"><b>${S.media.filter((m) => !m.busy).length}</b><span>Photos</span></div>
    </div>
    ${areaLabel() ? `📍 <b>${esc(areaLabel())}</b><br>` : ''}
    <b>${CAT_LABEL[S.category]}</b> · severity ${S.severity}/5 · sender <span class="mono"
      style="color:var(--teal-text)">${agentLine}</span>
    ${S.media.some((m) => m.busy) ? '<p class="sub">⏳ Still analysing a photo…</p>' : ''}`;
  $('#transmitBtn').disabled = !S.pin || S.media.some((m) => m.busy);
}

// ── transmit ──────────────────────────────────────────────────────────────
$('#transmitBtn').addEventListener('click', async () => {
  if (!S.pin) return toast('Drop a pin first.');
  if (!S.agent) {
    toast('Create your profile (or log in) first — your draft is kept.', 3200);
    return show('profile');
  }
  const btn = $('#transmitBtn');
  btn.disabled = true;
  btn.textContent = '👻 Ghosting your data…';
  showSafetyLoader();

  try {
    const res = await api('/api/reports', {
      body: {
        category: S.category, severity: S.severity,
        narrative: S.chat.filter((m) => m.author === 'agent').map((m) => m.body).join('. '),
        lat: S.pin.lat, lng: S.pin.lng, media: S.media.map((m) => m.src), chat: S.chat,
        zone_id: S.area.zoneId, section_id: S.area.sectionId,
      },
    });
    S.agent = res.agent;
    hideSafetyLoader();
    await proofBurst();
    renderHud();
    ghostReceipt(res);
    if (res.media_rejected) {
      toast(`${res.media_rejected} photo${res.media_rejected > 1 ? 's' : ''} couldn't be read and ${res.media_rejected > 1 ? 'were' : 'was'} not sent.`, 4500);
    }
    S.media = []; S.pin = null; S.area = { zoneId: null, sectionId: null };
    $('#townshipSearch').value = '';
    renderShots(); seedChat(); renderAreaPicker(); renderMap(); renderFeed();
  } catch (e) {
    hideSafetyLoader();
    toast('Transmit failed: ' + e.message, 4000);
  } finally {
    btn.textContent = '⚡ Transmit to City Power / SAPS';
    renderDraft();
  }
});

let loaderEl = null;
function showSafetyLoader() {
  loaderEl = document.createElement('div');
  loaderEl.className = 'modal-wrap';
  loaderEl.innerHTML = `<div class="modal" style="text-align:center;max-width:430px">
    <div style="font-size:46px">👻</div>
    <h2 style="color:var(--amber-text)">Ghosting your data</h2>
    <p class="sub">Stripping EXIF & GPS · blurring your pin · redacting names & numbers ·
      building the anonymous payload.</p>
    <div class="bar" style="margin-top:14px"><i style="width:0;animation:none" id="ldBar"></i></div>
    <p class="sub" style="margin-top:16px;color:var(--safety-ink)"><b>Real Msotra heroes report from a safe
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
    <p class="sub">Case <b class="mono" style="color:var(--amber-text)">${res.report.ref}</b> ·
      ${esc(placeLabel(res.report.zone, res.report.section))} (${res.report.crew}) · forwarded to
      <b>${g.forwarded_to.length ? g.forwarded_to.join(' + ').toUpperCase() : 'NOBODY — BLOCKED'}</b></p>

    <div style="margin-top:12px">
      <div class="stage"><div class="n">1</div><div><div class="t">Identity pseudonymised</div>
        <div class="d">Authorities see: <b style="color:var(--teal-text)">${g.agent_seen_by_authorities}</b>.
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
        Tripwire: <b style="color:${g.tripwire.passed ? 'var(--teal-text)' : 'var(--danger)'}">
        ${g.tripwire.passed ? 'PASSED' : 'BLOCKED — ' + (g.tripwire.violations || []).join(', ')}</b></div></div></div>
    </div>

    <h2 style="font-size:13px;margin-top:16px;color:var(--dim)">Exactly what left the building</h2>
    <pre class="payload">${JSON.stringify(g.outbound_payload, null, 2)}</pre>

    <p class="sub" style="margin-top:14px">Pending payout on verification:
      <b style="color:var(--amber-text)">${res.reward_pending.coins} Msotra Coins</b>
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
    S.selfVerified.add(ref);
    const v = await api('/api/verify', { body: { ref, authority: 'City Power Control' } });
    // The Control Room can verify anyone's case; only update the HUD if it's mine.
    const mine = S.agent && v.agent.ghost_id === S.agent.ghost_id;
    if (mine) S.agent = (await api('/api/me')).agent;
    renderHud();
    SFX.play('coin');
    toast(mine ? `✅ ${ref} verified — +${v.coins} Msotra Coins to you`
      : `✅ ${ref} verified — +${v.coins} Msotra Coins paid to ${v.agent.ghost_id}`);
    if (mine && (v.rank_up || v.rank !== 'Observer')) celebrateRank(v);
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
        <b>${CAT_LABEL[r.category] || r.category}</b> · ${esc(placeLabel(r.zone, r.section))}
        <div style="color:var(--dim);font-size:11px">${r.ref} · sev ${r.severity}/5 ·
          ${r.media} photo${r.media === 1 ? '' : 's'} · anonymous</div>
      </div>
      ${r.coins_awarded ? `<b style="color:var(--amber-text)">+${r.coins_awarded}</b>` : ''}
    </div>`).join('') : '<p class="sub">No drops yet. Be the first Guardian tonight.</p>';
}

// ── Agent Net: everyone's reports, reactions and threads ──────────────────
const REACT = [
  ['seen', '👀', 'I saw this too'],
  ['confirm', '✅', 'Confirmed — still like this'],
  ['careful', '⚠️', 'Danger — everyone keep away'],
  ['respect', '💪', 'Respect, Guardian'],
];
const NET = { items: new Map(), next: null, loading: false, open: new Set() };

const fmtWindow = (iso) => {
  const d = new Date(iso);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}, `
    + `~${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
};

function netCard(it) {
  return `<article class="net-card" data-ref="${it.ref}">
    <header class="net-head">
      <span class="badge ${esc(it.status)}">${esc(it.status)}</span>
      <b>${CAT_LABEL[it.category] || esc(it.category)}</b> · severity ${it.severity}/5
      ${it.mine ? '<span class="net-mine">YOUR REPORT</span>' : ''}
      <div class="net-meta">📍 ${esc(placeLabel(it.zone, it.section))} · near ${esc(it.landmark)} · area ±150 m · ${fmtWindow(it.observed_window)}</div>
    </header>
    ${it.photos.length ? `<div class="net-photos">${it.photos.map((p, i) => `
      <a href="${p}" target="_blank" rel="noopener"><img src="${p}" loading="lazy" alt="Evidence photo ${i + 1} for ${it.ref}"></a>`).join('')}</div>` : ''}
    ${it.description ? `<p class="net-desc">${esc(it.description)}</p>`
      : '<p class="sub">Description held back by Ghost Agent.</p>'}
    <div class="net-actions">
      ${REACT.map(([k, emoji, label]) => `
        <button type="button" class="react" data-react="${k}" title="${label}" aria-label="${label}"
          aria-pressed="${it.my_reactions.includes(k)}">${emoji} <span>${it.reactions[k] || 0}</span></button>`).join('')}
      <button type="button" class="react" data-thread aria-expanded="${NET.open.has(it.ref)}">💬 <span class="cc">${it.comments}</span></button>
      <button type="button" class="react" data-showmap title="Show the 150 m area on the map">🗺️ Area</button>
    </div>
    <div class="net-thread" ${NET.open.has(it.ref) ? '' : 'hidden'}></div>
  </article>`;
}

async function loadNet(more = false) {
  if (!S.agent || NET.loading) return;
  NET.loading = true;
  try {
    const q = more && NET.next ? `?before=${NET.next}` : '';
    const { items, next } = await api(`/api/net${q}`);
    if (!more) NET.items.clear();
    for (const it of items) NET.items.set(it.ref, it);
    NET.next = next;
    renderNet();
  } catch (e) {
    $('#netList').innerHTML = `<p class="sub">Couldn't load Agent Net: ${esc(e.message)}</p>`;
  } finally { NET.loading = false; }
}

function renderNet() {
  const items = [...NET.items.values()];
  $('#netList').innerHTML = items.length ? items.map(netCard).join('')
    : '<p class="sub">No reports yet. Be the first — tap “Post a report”.</p>';
  $('#netMore').hidden = !NET.next;
  for (const ref of NET.open) loadThread(ref);
}

function updateCard(ref) {
  const it = NET.items.get(ref);
  const el = document.querySelector(`.net-card[data-ref="${ref}"]`);
  if (!it || !el) return;
  const thread = el.querySelector('.net-thread');
  const draft = thread.querySelector('textarea')?.value;
  el.outerHTML = netCard(it);
  if (NET.open.has(ref)) loadThread(ref, draft);
}

async function loadThread(ref, draft = '') {
  const el = document.querySelector(`.net-card[data-ref="${ref}"] .net-thread`);
  if (!el) return;
  try {
    const { comments, my_alias } = await api(`/api/reports/${ref}/comments`);
    const keep = el.querySelector('textarea')?.value || draft;
    el.innerHTML = `
      <div class="comments">${comments.length ? comments.map((c) => `
        <div class="comment ${c.is_me ? 'me' : ''} ${c.is_reporter ? 'reporter' : ''}">
          <b>${esc(c.author)}${c.is_me ? ' (you)' : ''}</b>
          <span class="when">${esc(String(c.created_at).slice(11, 16))}</span>
          <p>${esc(c.body)}</p></div>`).join('')
        : '<p class="sub">No messages yet. Seen it too? Say so — never say who you are.</p>'}</div>
      <form class="comment-form">
        <label class="sub" for="cf-${ref}">Posting as <b>${esc(my_alias)}</b> in this thread only</label>
        <div class="row">
          <textarea id="cf-${ref}" maxlength="500" rows="2" placeholder="What did you see? No names, numbers or addresses."></textarea>
          <button class="btn sm teal" type="submit">Send</button>
        </div>
      </form>`;
    el.querySelector('textarea').value = keep;
    const list = el.querySelector('.comments');
    list.scrollTop = list.scrollHeight;
  } catch (e) { el.innerHTML = `<p class="sub">${esc(e.message)}</p>`; }
}

$('#netMore').addEventListener('click', () => loadNet(true));

$('#netList').addEventListener('click', async (e) => {
  const card = e.target.closest('.net-card');
  if (!card) return;
  const ref = card.dataset.ref;
  const it = NET.items.get(ref);

  const r = e.target.closest('button[data-react]');
  if (r) {
    try {
      const { reactions, mine } = await api(`/api/reports/${ref}/react`, { body: { kind: r.dataset.react } });
      it.reactions = reactions;
      it.my_reactions = mine ? [...new Set([...it.my_reactions, r.dataset.react])]
        : it.my_reactions.filter((k) => k !== r.dataset.react);
      SFX.play('tick');
      updateCard(ref);
    } catch (err) { toast(err.message, 3000); }
    return;
  }
  if (e.target.closest('button[data-thread]')) {
    if (NET.open.has(ref)) NET.open.delete(ref); else NET.open.add(ref);
    updateCard(ref);
    return;
  }
  if (e.target.closest('button[data-showmap]')) showAreaOnMap(it);
});

$('#netList').addEventListener('submit', async (e) => {
  e.preventDefault();
  const card = e.target.closest('.net-card');
  const ta = e.target.querySelector('textarea');
  const text = ta.value.trim();
  if (!text) return;
  try {
    const { findings, comments } = await api(`/api/reports/${card.dataset.ref}/comments`, { body: { body: text } });
    ta.value = '';
    if (findings.length) {
      toast(`Ghost Agent removed ${findings.map((f) => f.rule.replace(/_/g, ' ')).join(', ')} from your message.`, 4000);
    }
    NET.items.get(card.dataset.ref).comments = comments;
    updateCard(card.dataset.ref);
  } catch (err) { toast(err.message, 3500); }
});
$('#netList').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && e.target.matches('.comment-form textarea')) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

/** Opens the street map zoomed to a report's blurred 150 m cell. */
function showAreaOnMap(it) {
  if (mapMode !== 'street' && window.L) { mapMode = 'street'; renderMap(); }
  show('map');
  setTimeout(() => {
    if (!osm) return toast(`Area: ${it.lat.toFixed(4)}, ${it.lng.toFixed(4)} (±150 m)`, 4000);
    const h = 0.00135 / 2;
    const bounds = [[it.lat - h, it.lng - h], [it.lat + h, it.lng + h]];
    osm.map.invalidateSize();
    osm.needsFit = false;
    osm.view?.remove();
    osm.view = L.rectangle(bounds, { className: 'osm-view', weight: 3, dashArray: '4 4', fillOpacity: 0.15, interactive: false })
      .bindTooltip(`${CAT_LABEL[it.category]} · ${it.ref}`, { permanent: true, direction: 'top' })
      .addTo(osm.map);
    osm.map.fitBounds(bounds, { maxZoom: 17 });
  }, 80);
}

// ── wallet ────────────────────────────────────────────────────────────────
async function loadWallet() {
  if (!S.agent) {
    $('#walletBalance').textContent = '0';
    $('#store').innerHTML = '<p class="sub">Create a profile (or log in) on the Profile tab to open a wallet.</p>';
    return;
  }
  const w = await api('/api/wallet');
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
    <div class="row" style="display:flex;gap:9px;align-items:center;padding:8px 0;border-bottom:1px solid var(--line2)">
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
    const r = await api('/api/redeem', { body: { sku: b.dataset.sku } });
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
      <td style="color:var(--amber-text);font-weight:900">${c.coins}</td>
      <td style="color:${healthColour(c.grid_health)}">${c.grid_health}%</td></tr>`).join('');

  $('#zoneBoard').innerHTML = b.zones.map((z) => `
    <tr><td><b>${z.name}</b></td><td style="color:var(--dim)">${z.landmark}</td>
      <td>${z.reports}</td><td>${z.verified}</td>
      <td><div class="bar"><i style="width:${z.grid_health}%;background:${healthColour(z.grid_health)}"></i></div>
        <small style="color:var(--dim)">${z.grid_health}%</small></td></tr>`).join('');

  $('#agentBoard').innerHTML = b.agents.length ? b.agents.map((a, i) => `
    <tr class="${a.ghost_id === S.agent?.ghost_id ? 'me' : ''}">
      <td><div class="pos p${i + 1}">${i + 1}</div></td>
      <td>${a.avatar} <span class="mono">${a.ghost_id}</span>${a.ghost_id === S.agent?.ghost_id ? ' <b style="color:var(--amber-text)">(you)</b>' : ''}
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
    <b style="color:var(--teal-text);font-size:16px">${a.totals.redactions}</b> redactions logged as
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
  const r = await api('/api/escape/start', { body: { team_name: team, zone_id: S.agent?.home_zone_id ?? null } });
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
      seconds_left: Math.max(0, escLeft),
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
    if (S.agent) { S.agent = (await api('/api/me')).agent; renderHud(); }
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
  // Agent Net live: new reports, new messages, reactions from other agents.
  const netActive = () => S.agent && $('#view-net').classList.contains('active');
  es.addEventListener('net', async (e) => {
    if (!netActive()) return;
    const { ref } = JSON.parse(e.data);
    try {
      const { item } = await api(`/api/net/item?ref=${encodeURIComponent(ref)}`);
      NET.items = new Map([[item.ref, item], ...NET.items]);
      renderNet();
    } catch { /* ignore */ }
  });
  es.addEventListener('comment', (e) => {
    const { ref, comments } = JSON.parse(e.data);
    const it = NET.items.get(ref);
    if (!it || !netActive()) return;
    it.comments = comments;
    updateCard(ref);
  });
  es.addEventListener('reaction', (e) => {
    const { ref, reactions } = JSON.parse(e.data);
    const it = NET.items.get(ref);
    if (!it || !netActive()) return;
    it.reactions = reactions;
    updateCard(ref);
  });
  es.addEventListener('verified', (e) => {
    const { ref, outcome } = JSON.parse(e.data);
    const it = NET.items.get(ref);
    if (it && netActive()) { it.status = outcome; updateCard(ref); }
  });

  // Live totals: every drop / verification anywhere updates the counters.
  es.addEventListener('stats', (e) => { S.stats = JSON.parse(e.data); renderStats(); });
  es.addEventListener('open', () => {
    api('/api/stats').then((s) => { S.stats = s; renderStats(); }).catch(() => {});
  });
  es.addEventListener('verified', (e) => {
    const d = JSON.parse(e.data);
    if (d.outcome === 'verified') {
      refreshMe(d.ref); // coins land automatically — tell me if one of mine was verified
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
