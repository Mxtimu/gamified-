import {
  $, $$, esc, api, CAT_LABEL, nf, ago, when, bytes, toast, themeButton, gate,
  columnChart, hbars, reportCard, wireDecisions,
} from '/portal.js';

const loaded = new Set();
let current = 'overview';

const loaders = {
  overview: loadOverview, reports: () => loadReports(), delivery: loadDelivery, agents: loadAgents,
  wallet: loadWallet, moderation: loadComments, system: loadSystem, links: loadLinks,
};

gate('admin', () => {
  themeButton($('#themeBtn'));
  $('#logoutBtn').addEventListener('click', async () => { await api('/api/staff/logout', {}); location.reload(); });
  $('#refreshBtn').addEventListener('click', () => refresh());
  $$('.ptabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  setupReportFilters();
  wireDecisions($('#reportList'), '/api/admin/verify', () => { loadReports(); loaded.delete('overview'); loaded.delete('delivery'); });
  wireDecisions($('#waitingList'), '/api/admin/verify', () => { loadDelivery(); loaded.delete('overview'); loaded.delete('reports'); });
  showTab(location.hash.slice(1) in loaders ? location.hash.slice(1) : 'overview');

  // Live: the app's own event stream nudges the open tab when something happens.
  const es = new EventSource('/events');
  let t = null;
  const nudge = () => { loaded.clear(); clearTimeout(t); t = setTimeout(() => refresh(true), 1500); };
  ['report', 'verified', 'comment', 'stats'].forEach((ev) => es.addEventListener(ev, nudge));
  setInterval(() => refresh(true), 60_000); // safety net if the stream drops
});

function showTab(tab) {
  current = tab;
  history.replaceState(null, '', '#' + tab);
  $$('.ptabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('.pview').forEach((v) => v.classList.toggle('active', v.id === 'tab-' + tab));
  if (!loaded.has(tab)) refresh();
}

async function refresh(quiet = false) {
  try {
    await loaders[current]();
    loaded.add(current);
    $('#updated').textContent = 'Updated ' + new Date().toLocaleTimeString('en-ZA', { timeStyle: 'short' });
  } catch (err) {
    if (err.status === 401) return location.reload();
    if (!quiet) toast(err.message);
  }
}

const kpi = (value, label, note = '') => `<div class="stat"><b>${value}</b><span>${esc(label)}</span>${note ? `<small>${note}</small>` : ''}</div>`;

// ── overview ───────────────────────────────────────────────────────────────
async function loadOverview() {
  const d = await api('/api/admin/overview');
  const t = d.totals, s = d.by_status;
  const open = s.submitted + s.forwarded;
  $('#kpis').innerHTML = [
    kpi(nf(t.agents), 'Agents', `+${t.agents_new_7d} this week · ${t.agents_active_7d} active`),
    kpi(nf(t.reports), 'Reports', `${t.reports_today} today · ${t.reports_7d} this week`),
    kpi(nf(s.verified), 'Verified', t.reports ? `${Math.round((s.verified / t.reports) * 100)}% of reports` : ''),
    kpi(nf(open), 'Awaiting decision', open ? '<a href="#delivery" data-jump="delivery">see the queue</a>' : 'queue is clear'),
    kpi(nf(t.coins_outstanding), 'Coins held by agents', `${nf(t.coins_issued)} issued · ${nf(t.coins_redeemed)} redeemed`),
    kpi(`${t.townships_reporting}/${t.townships}`, 'Townships reporting'),
  ].join('');
  $$('[data-jump]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); showTab(a.dataset.jump); }));

  columnChart($('#dailyChart'), d.daily.map((r) => ({
    label: new Date(r.date + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' }),
    value: r.reports,
    tip: `<b>${new Date(r.date + 'T00:00:00').toLocaleDateString('en-ZA', { weekday: 'short', day: 'numeric', month: 'short' })}</b><br>${r.reports} reports · ${r.verified} verified`,
  })));
  hbars($('#statusBars'), Object.entries(s).map(([k, v]) => ({ label: k[0].toUpperCase() + k.slice(1), value: v })));
  hbars($('#catBars'), d.by_category.map((c) => ({ label: CAT_LABEL[c.category] || c.category, value: c.n })), 'No reports yet.');
  $('#townBody').innerHTML = d.top_townships.length ? d.top_townships.map((z) => `
    <tr><td>${esc(z.township)}</td><td class="num">${z.reports}</td><td class="num">${z.verified}</td>
      <td class="num">${z.grid_health}%</td></tr>`).join('')
    : '<tr><td colspan="4" class="muted">No reports yet.</td></tr>';
  const icon = { report: '📍', verified: '✅', rejected: '✕', redemption: '🪙', agent: '👤' };
  const text = (e) => ({
    report: `New report <span class="mono">${esc(e.label)}</span> · ${esc(CAT_LABEL[e.detail] || e.detail)}`,
    verified: `<span class="mono">${esc(e.label)}</span> verified by ${esc(e.detail)}`,
    rejected: `<span class="mono">${esc(e.label)}</span> rejected by ${esc(e.detail)}`,
    redemption: `Redeemed ${esc(e.label)} (${esc(e.detail)})`,
    agent: `New agent <span class="mono">${esc(e.label)}</span>`,
  })[e.kind];
  $('#activity').innerHTML = d.recent.length
    ? d.recent.map((e) => `<li><time title="${when(e.at)}">${ago(e.at)}</time><span>${icon[e.kind]} ${text(e)}</span></li>`).join('')
    : '<li class="muted">Nothing yet.</li>';
}

// ── reports ────────────────────────────────────────────────────────────────
let reportNext = null;
function setupReportFilters() {
  $('#fCat').insertAdjacentHTML('beforeend',
    Object.entries(CAT_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''));
  api('/api/partner/zones').then(({ zones }) => {
    $('#fTown').insertAdjacentHTML('beforeend', zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join(''));
  }).catch(() => {});
  let t;
  ['#fStatus', '#fTown', '#fCat'].forEach((s) => $(s).addEventListener('change', () => loadReports()));
  $('#fRef').addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => loadReports(), 300); });
  $('#reportMore').addEventListener('click', () => loadReports(true));
}
async function loadReports(more = false) {
  const p = new URLSearchParams();
  if ($('#fStatus').value) p.set('status', $('#fStatus').value);
  if ($('#fTown').value) p.set('zone_id', $('#fTown').value);
  if ($('#fCat').value) p.set('category', $('#fCat').value);
  if ($('#fRef').value.trim()) p.set('q', $('#fRef').value.trim());
  if (more && reportNext) p.set('before', reportNext);
  const d = await api('/api/admin/reports?' + p);
  reportNext = d.next;
  const html = d.items.map((r) => reportCard(r, { decide: true })).join('');
  if (more) $('#reportList').insertAdjacentHTML('beforeend', html);
  else $('#reportList').innerHTML = html || '<p class="sub">No reports match.</p>';
  $('#reportMore').hidden = !d.next;
}

// ── delivery to City Power / SAPS ──────────────────────────────────────────
async function loadDelivery() {
  const d = await api('/api/admin/delivery');
  $('#deliveryNotice').innerHTML = d.live ? '' : `<div class="notice"><b>Not connected to City Power yet.</b>
    Reports are prepared and logged as "sent" here, but nothing is transmitted to a real City Power or SAPS
    system. Until that link exists, share the partner portal so they can see and decide on cases.</div>`;
  const waiting = d.waiting.length;
  const overdue = d.waiting.filter((r) => r.age_hours > 24).length;
  $('#deliveryKpis').innerHTML = [
    kpi(nf(waiting), 'Waiting for a decision', overdue ? `<span class="warnline">${overdue} older than 24 h</span>` : 'none overdue'),
    kpi(nf(d.timing.decided), 'Decided'),
    kpi(d.timing.avg_hours != null ? `${d.timing.avg_hours} h` : '—', 'Average time to decide',
      d.timing.max_hours != null ? `slowest ${d.timing.max_hours} h` : ''),
    kpi(nf(d.blocked_by_tripwire), 'Held back by privacy trip-wire', 'never sent to anyone'),
  ].join('');
  const names = { city_power: 'City Power', saps: 'SAPS' };
  const eps = Object.entries(d.endpoints);
  $('#endpointBody').innerHTML = eps.length ? eps.map(([k, v]) => `
    <tr><td>${esc(names[k] || k)}</td><td class="num">${v.sent || 0}</td><td class="num">${v.failed || 0}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">Nothing sent yet.</td></tr>';
  $('#authorityBody').innerHTML = d.by_authority.length ? d.by_authority.map((a) => `
    <tr><td>${esc(a.authority)}</td><td><span class="badge ${esc(a.status)}">${esc(a.status)}</span></td>
      <td class="num">${a.n}</td></tr>`).join('')
    : '<tr><td colspan="3" class="muted">No decisions yet.</td></tr>';
  $('#waitingList').innerHTML = d.waiting.map((r) => reportCard(r, { decide: true, ageHours: r.age_hours })).join('')
    || '<p class="sub">Queue is clear.</p>';
}

// ── agents ─────────────────────────────────────────────────────────────────
async function loadAgents() {
  const { agents } = await api('/api/admin/agents');
  $('#agentBody').innerHTML = agents.length ? agents.map((a) => `
    <tr><td>${esc(a.avatar)}</td><td class="mono">${esc(a.ghost_id)}</td><td>${esc(a.callsign)}</td>
      <td>${esc(a.home_township || '—')}</td><td>${esc(a.rank)}</td>
      <td class="num">${nf(a.xp)}</td><td class="num">${nf(a.coins)}</td>
      <td class="num">${a.reports}</td><td class="num">${a.verified}</td>
      <td title="${when(a.last_report)}">${a.last_report ? ago(a.last_report) : '—'}</td>
      <td title="${when(a.created_at)}">${ago(a.created_at)}</td></tr>`).join('')
    : '<tr><td colspan="11" class="muted">No agents yet.</td></tr>';
}

// ── wallet ─────────────────────────────────────────────────────────────────
async function loadWallet() {
  const [w, o] = await Promise.all([api('/api/admin/redemptions'), api('/api/admin/overview')]);
  const t = o.totals;
  $('#walletKpis').innerHTML = [
    kpi(nf(t.coins_issued), 'Coins issued'),
    kpi(nf(t.coins_redeemed), 'Coins redeemed', `${nf(t.redemptions)} vouchers`),
    kpi(nf(t.coins_outstanding), 'Coins held by agents', 'could still be redeemed'),
  ].join('');
  hbars($('#itemBars'), w.by_item.map((i) => ({ label: i.label, value: i.n, note: `${nf(i.coins)} coins` })), 'No redemptions yet.');
  $('#redeemBody').innerHTML = w.recent.length ? w.recent.map((r) => `
    <tr><td title="${when(r.created_at)}">${ago(r.created_at)}</td><td>${esc(r.label)}</td><td class="num">${r.cost}</td>
      <td class="mono">${esc(r.ghost_id)}</td><td class="mono">${esc(r.voucher_code)}</td></tr>`).join('')
    : '<tr><td colspan="5" class="muted">No redemptions yet.</td></tr>';
}

// ── moderation ─────────────────────────────────────────────────────────────
async function loadComments() {
  const { comments } = await api('/api/admin/comments');
  $('#commentList').innerHTML = comments.length ? comments.map((c) => `
    <li data-id="${c.id}"><time title="${when(c.created_at)}">${ago(c.created_at)}</time>
      <span style="flex:1"><b>${esc(c.alias)}</b> on <span class="mono">${esc(c.ref)}</span><br>${esc(c.body)}</span>
      <button class="pbtn bad" data-del="${c.id}" type="button">Delete</button></li>`).join('')
    : '<li class="muted">No comments yet.</li>';
}
$('#commentList')?.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-del]');
  if (!b || !confirm('Delete this comment for everyone?')) return;
  try { await api('/api/admin/comments/delete', { id: Number(b.dataset.del) }); toast('Comment deleted'); loadComments(); }
  catch (err) { toast(err.message); }
});

// ── system ─────────────────────────────────────────────────────────────────
async function loadSystem() {
  const h = await api('/api/admin/health');
  $('#warnings').innerHTML = h.warnings.map((w) => `<li class="warnline">${esc(w)}</li>`).join('');
  $('#warnPanel').hidden = !h.warnings.length;
  const up = h.server.uptime_s;
  const upText = up < 3600 ? `${Math.floor(up / 60)} min` : up < 86400 ? `${Math.floor(up / 3600)} h` : `${Math.floor(up / 86400)} d`;
  $('#sysKpis').innerHTML = [
    kpi(upText, 'Server up', `since ${when(h.server.started_at)}`),
    kpi(nf(h.server.live_viewers), 'People on the app now', 'open live connections'),
    kpi(`${h.server.memory_mb} MB`, 'Memory', `Node ${esc(h.server.node)}`),
    kpi(bytes(h.storage.db_bytes), 'Database'),
    kpi(bytes(h.storage.media.bytes), 'Evidence photos', `${nf(h.storage.media.files)} files`),
    kpi(bytes(h.storage.tiles.bytes), 'Map tile cache', `${nf(h.storage.tiles.files)} tiles`),
  ].join('');
  const c = h.cloud;
  $('#cloudBox').innerHTML = !c.enabled
    ? '<p class="sub">Off. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to .env to back up anonymised data off this machine.</p>'
    : `<div class="kpis" style="margin-top:8px">
        ${kpi(c.failing ? '⚠️ Retrying' : '✅ OK', 'Status')}
        ${kpi(nf(c.outbox.pending), 'Waiting to upload', c.outbox.retrying ? `${c.outbox.retrying} retrying` : '')}
        ${kpi(nf(c.outbox.done), 'Uploaded')}
      </div>
      <p class="sub">Last success: ${c.last_ok ? when(c.last_ok) : '—'}</p>
      ${c.recent_errors.length ? `<ul class="warnlist">${c.recent_errors.map((e) =>
        `<li class="warnline"><span class="mono">${esc(e.target)}</span> · ${e.attempts} tries · ${esc(e.last_error)}</li>`).join('')}</ul>` : ''}`;
  const t = h.tiles;
  $('#tileBox').innerHTML = `<div class="kpis" style="margin-top:8px">
      ${kpi(nf(t.served), 'Tiles served', 'since restart')}
      ${kpi(nf(t.fetched), 'Fetched from OSM')}
      ${kpi(nf(t.failed), 'Failed fetches')}
    </div>
    <p class="sub">${t.last_error ? `<span class="warnline">Last failure ${ago(t.last_error.at)}: ${esc(t.last_error.message)}</span>`
      : 'No fetch failures since restart.'} Areas already cached keep working offline.</p>`;
}

// ── portal links ───────────────────────────────────────────────────────────
async function loadLinks() {
  const me = await api('/api/staff/me');
  $('#partnerLink').textContent = location.origin + '/partner.html';
  $('#impactLink').textContent = location.origin + '/impact.html';
  $('#partnerState').innerHTML = me.partner_enabled
    ? '✅ Switched on.'
    : '<span class="warnline">Switched off: add PARTNER_PASSWORD (10+ characters) to .env and restart.</span>';
}
