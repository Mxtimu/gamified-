// Shared helpers for the staff portals and the public impact page.
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export async function api(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || r.statusText), { status: r.status });
  return data;
}

export const CAT_LABEL = {
  cable_theft: 'Cable theft', substation_vandalism: 'Mini-sub vandalism', open_chamber: 'Open chamber',
  illegal_connection: 'Illegal connection', streetlight_out: 'Streetlights out',
};
export const nf = (n) => Number(n || 0).toLocaleString('en-ZA');
export const place = (t, s) => (!s ? t : s.toLowerCase().startsWith(String(t).toLowerCase()) ? s : `${t} · ${s}`);

export function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const when = (iso) => (iso ? new Date(iso).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export function bytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

export function toast(msg) {
  let t = $('#ptoast');
  if (!t) {
    t = Object.assign(document.createElement('div'), { id: 'ptoast', className: 'toast' });
    t.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:50;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:13px;max-width:90vw';
    document.body.append(t);
  }
  t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, 3200);
}

// Same theme switch as the main app (shared localStorage key).
export function themeButton(btn) {
  const cur = () => document.documentElement.dataset.theme || 'dark';
  const paint = () => { btn.textContent = cur() === 'light' ? '🌙 Night' : '☀️ Daylight'; };
  btn.addEventListener('click', () => {
    const next = cur() === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('msotra.theme', next); } catch { /* private mode */ }
    paint();
  });
  paint();
}

/**
 * Shows the password gate until the visitor has the given role, then calls onReady.
 * Admins may also open the partner portal.
 */
export async function gate(role, onReady) {
  const me = await api('/api/staff/me');
  const ok = me.role === role || (role === 'partner' && me.role === 'admin');
  if (ok) return onReady(me.role);
  const enabled = role === 'admin' ? me.admin_enabled : me.partner_enabled;
  const envName = role === 'admin' ? 'ADMIN_PASSWORD' : 'PARTNER_PASSWORD';
  document.body.innerHTML = `
    <div class="gate"><div class="panel">
      <h2>${role === 'admin' ? 'Admin portal' : 'Partner portal'}</h2>
      ${enabled ? `
        <p class="sub">${role === 'admin' ? 'Grid Guardians internal dashboard.' : 'City Power / SAPS case desk: anonymous, blurred reports.'}</p>
        <form id="gateForm">
          <input type="password" id="gatePw" placeholder="Password" autocomplete="current-password" required>
          <div class="err" id="gateErr"></div>
          <button class="pbtn ok" style="width:100%">Log in</button>
        </form>` : `
        <p class="sub">This portal is switched off. Add <span class="mono">${envName}=</span> followed by a password of at
          least 10 characters to the <span class="mono">.env</span> file next to server.mjs, then restart the server.</p>`}
    </div></div>`;
  $('#gateForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/staff/login', { role, password: $('#gatePw').value });
      location.reload();
    } catch (err) { $('#gateErr').textContent = err.message; }
  });
}

/** Single-series column chart with a hover tooltip. rows: [{label, value, tip}] */
export function columnChart(el, rows, { height = 180 } = {}) {
  const W = 720, H = height, padL = 28, padB = 22, padT = 8;
  const max = Math.max(1, ...rows.map((r) => r.value));
  const step = Math.max(1, Math.ceil(max / 4));
  const top = step * Math.ceil(max / step);
  const bw = (W - padL) / rows.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Column chart">
    ${ticks.map((v) => `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/>
      <text class="axis" x="${padL - 6}" y="${y(v) + 3}" text-anchor="end">${v}</text>`).join('')}
    ${rows.map((r, i) => {
      const h = Math.max(0, y(0) - y(r.value));
      const x = padL + i * bw + 1, w = Math.max(2, bw - 2); // 2px gap between bars
      return `<rect class="hit" data-i="${i}" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>
        ${r.value ? `<path class="bar" data-i="${i}" d="M${x},${y(0)} v${-(h - Math.min(4, h))} q0,${-Math.min(4, h)} ${Math.min(4, w / 2)},${-Math.min(4, h)} h${w - 2 * Math.min(4, w / 2)} q${Math.min(4, w / 2)},0 ${Math.min(4, w / 2)},${Math.min(4, h)} v${h - Math.min(4, h)} z"/>` : ''}`;
    }).join('')}
    ${rows.map((r, i) => (i % Math.ceil(rows.length / 6) === 0 || i === rows.length - 1
      ? `<text class="axis" x="${padL + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${esc(r.label)}</text>` : '')).join('')}
  </svg><div class="tip" hidden></div>`;
  const tip = $('.tip', el), svg = $('svg', el);
  svg.addEventListener('pointermove', (e) => {
    const hit = e.target.closest('[data-i]');
    $$('.bar', svg).forEach((b) => b.classList.toggle('hover', hit && b.dataset.i === hit.dataset.i));
    if (!hit) { tip.hidden = true; return; }
    const r = rows[hit.dataset.i];
    const box = el.getBoundingClientRect();
    tip.innerHTML = r.tip;
    tip.style.left = `${e.clientX - box.left}px`;
    tip.style.top = `${e.clientY - box.top}px`;
    tip.hidden = false;
  });
  svg.addEventListener('pointerleave', () => { tip.hidden = true; $$('.bar', svg).forEach((b) => b.classList.remove('hover')); });
}

/** One report as a card. Open cases get Verify / Reject buttons when `decide` is true. */
export function reportCard(r, { decide = false, ageHours = null, authorityPicker = false } = {}) {
  const open = r.status === 'submitted' || r.status === 'forwarded';
  const osm = `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=17/${r.lat}/${r.lng}`;
  return `<article class="rcard${ageHours != null && ageHours > 24 ? ' old' : ''}" data-ref="${esc(r.ref)}">
    <div class="top">
      <span class="badge ${esc(r.status)}">${esc(r.status)}</span>
      <b>${esc(CAT_LABEL[r.category] || r.category)}</b>
      <span class="muted">severity ${r.severity}/5</span>
      <span class="spacer" style="flex:1"></span>
      <span class="mono muted">${esc(r.ref)}</span>
    </div>
    <div class="meta">📍 <b style="color:var(--ink)">${esc(place(r.township, r.section))}</b> · near ${esc(r.landmark)} ·
      <a href="${osm}" target="_blank" rel="noopener">map (±${r.precision_m} m)</a><br>
      Reported ${when(r.created_at)} (${ago(r.created_at)})${ageHours != null ? ` · waiting ${ageHours} h` : ''}
      ${r.sent_to?.length ? ` · sent to ${r.sent_to.map((s) => esc(s.replace('_', ' ').toUpperCase())).join(' + ')}` : ''}
      ${r.verified_by ? `<br>Decided by ${esc(r.verified_by)} · ${when(r.verified_at)}${r.coins_awarded ? ` · ${r.coins_awarded} coins paid` : ''}` : ''}
    </div>
    ${r.blocked ? '<p class="desc warnline">Description withheld: the privacy trip-wire fired on this report.</p>'
      : r.description ? `<p class="desc">${esc(r.description)}</p>` : ''}
    ${r.photos?.length ? `<div class="photos">${r.photos.map((p) => `<a href="${esc(p)}" target="_blank" rel="noopener"><img src="${esc(p)}" alt="Evidence photo" loading="lazy"></a>`).join('')}</div>` : ''}
    ${decide && open ? `<div class="actions">
      ${authorityPicker ? `<select class="authority" aria-label="Your organisation" style="background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:9px;padding:8px;font:inherit;font-size:13px">
        <option value="City Power">City Power</option><option value="SAPS">SAPS</option></select>` : ''}
      <button class="pbtn ok" data-decide="verified" type="button">✓ Verified on site</button>
      <button class="pbtn bad" data-decide="rejected" type="button">✕ Reject</button>
    </div>` : ''}
  </article>`;
}

/** Wires Verify / Reject buttons inside `container` to the given endpoint. */
export function wireDecisions(container, endpoint, after) {
  container.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-decide]');
    if (!b) return;
    const card = b.closest('.rcard');
    const outcome = b.dataset.decide;
    if (outcome === 'rejected' && !confirm(`Reject ${card.dataset.ref}? The reporter gets no coins.`)) return;
    $$('button', card).forEach((x) => { x.disabled = true; });
    try {
      const r = await api(endpoint, { ref: card.dataset.ref, outcome, authority: $('.authority', card)?.value });
      toast(outcome === 'verified' ? `${r.ref} verified · ${r.coins} coins paid to the reporter` : `${r.ref} rejected`);
      after();
    } catch (err) {
      toast(err.message);
      $$('button', card).forEach((x) => { x.disabled = false; });
    }
  });
}

/** Horizontal bars, one series. rows: [{label, value, note?}] */
export function hbars(el, rows, empty = 'Nothing yet.') {
  const max = Math.max(1, ...rows.map((r) => r.value));
  el.innerHTML = rows.length ? `<div class="hbars">${rows.map((r) => `
    <div class="hbar" title="${esc(r.label)}: ${nf(r.value)}${r.note ? ' · ' + esc(r.note) : ''}">
      <span>${esc(r.label)}</span>
      <div class="track"><div class="fill" style="width:${(r.value / max) * 100}%"></div></div>
      <b>${nf(r.value)}</b>
    </div>`).join('')}</div>` : `<p class="sub">${esc(empty)}</p>`;
}
