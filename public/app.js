const $ = (id) => document.getElementById(id);
const state = { upload: null, uploads: [], page: 1, reqSeq: { stats: 0, logs: 0 } };

// ------------------------------------------------------------------ period

function periodParams() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  const p = new URLSearchParams();
  $('period-error').textContent = '';
  if (mode === 'date' && $('date').value) p.set('date', $('date').value);
  if (mode === 'range') {
    const from = $('from').value, to = $('to').value;
    if (from && to && from > to) {
      $('period-error').textContent = '"From" is after "To".';
      return null;
    }
    if (from) p.set('from', from);
    if (to) p.set('to', to);
  }
  return p;
}

function onModeChange() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  $('f-date').hidden = mode !== 'date';
  $('f-from').hidden = $('f-to').hidden = mode !== 'range';
  state.page = 1;
  refresh();
}

function periodLabel() {
  const mode = document.querySelector('input[name=mode]:checked').value;
  if (mode === 'date' && $('date').value) return `· ${$('date').value}`;
  if (mode === 'range' && ($('from').value || $('to').value)) return `· ${$('from').value || '…'} → ${$('to').value || '…'}`;
  return '· whole dataset';
}

// ------------------------------------------------------------------- stats

const cls = (meets) => (meets === null ? 'warn' : meets ? 'ok' : 'bad');
const dayCls = (pct) => (pct === null ? '' : pct >= 99.9 ? 'ok' : pct >= 99 ? 'warn' : 'bad');

function renderStats(s) {
  const o = s.overall;
  if (!o.checks) {
    $('stats-body').innerHTML = '<div class="empty muted">No checks in this period.</div>';
    return;
  }
  const totalDown = s.services.reduce((a, x) => a + x.downtimeMinutes, 0);
  const totalIncidents = s.incidents.length;
  const longest = s.incidents[0];

  const kpis = `<div class="kpis">
    <div class="kpi"><div class="l">Fleet availability</div><div class="v">${fmtPct(o.availabilityPercent)}</div><div class="s">target ${s.targetPercent}% · ${fmtInt(o.up)} up / ${fmtInt(o.down)} down</div></div>
    <div class="kpi"><div class="l">Services breaching SLA</div><div class="v"><span class="badge ${o.servicesBreaching ? 'bad' : 'ok'}">${o.servicesBreaching} of ${o.services}</span></div><div class="s">availability below ${s.targetPercent}%</div></div>
    <div class="kpi"><div class="l">Total downtime</div><div class="v">${fmtDur(totalDown)}</div><div class="s">${s.slotMinutes}-min window per failed check</div></div>
    <div class="kpi"><div class="l">Incidents</div><div class="v">${fmtInt(totalIncidents)}</div><div class="s">${longest ? `longest ${fmtDur(longest.durationMinutes)} (${esc(longest.serviceName)})` : 'none'}</div></div>
  </div>`;

  const svcRows = s.services.map((x) => `<tr>
    <td><strong>${esc(x.serviceName)}</strong> <span class="muted mono">${esc(x.serviceId)}</span></td>
    <td class="num">${fmtPct(x.availabilityPercent)}</td>
    <td><span class="badge ${cls(x.meetsSla)}">${x.meetsSla === null ? 'no data' : x.meetsSla ? 'meets SLA' : 'breach'}</span></td>
    <td class="num">${fmtDur(x.downtimeMinutes)}</td>
    <td class="num" title="Allowed downtime at ${s.targetPercent}% for the counted period">${x.errorBudgetRemainingMinutes >= 0 ? fmtDur(Math.floor(x.errorBudgetRemainingMinutes)) + ' left' : '<span class="badge bad">over by ' + fmtDur(Math.ceil(-x.errorBudgetRemainingMinutes)) + '</span>'}</td>
    <td class="num">${x.incidentCount} · max ${fmtDur(x.longestOutageMinutes)}</td>
    <td class="num">${fmtMs(x.latencyP50)} / ${fmtMs(x.latencyP95)} / ${fmtMs(x.latencyMax)}</td>
  </tr>`).join('');
  const svcTable = `<h3>Per service</h3><div class="scroll"><table>
    <thead><tr><th>Service</th><th class="num">Availability</th><th>Verdict</th><th class="num">Downtime</th><th class="num">Error budget</th><th class="num">Incidents</th><th class="num" title="milliseconds">Latency p50 / p95 / max (ms)</th></tr></thead>
    <tbody>${svcRows}</tbody></table></div>`;

  const strips = s.services.map((x) => {
    const cells = (s.daily[x.serviceId] || []).map((d) =>
      `<span class="cell ${dayCls(d.availabilityPercent)}" title="${d.day}: ${fmtPct(d.availabilityPercent)} (${d.down} failed of ${d.checks})" role="img" aria-label="${d.day} ${fmtPct(d.availabilityPercent)}"></span>`).join('');
    return `<div class="strip-row"><span>${esc(x.serviceName)}</span><div class="strip">${cells}</div></div>`;
  }).join('');
  const daily = `<h3>Daily availability (UTC)</h3>${strips}
    <div class="legend"><span><i style="background:var(--ok)"></i>≥ 99.9%</span><span><i style="background:var(--warn)"></i>99–99.9%</span><span><i style="background:var(--bad)"></i>&lt; 99%</span><span>hover a cell for the exact value</span></div>`;

  const nameOf = Object.fromEntries(s.services.map((x) => [x.serviceId, x.serviceName]));
  const monthRows = s.months.map((m) => `<tr>
    <td>${esc(nameOf[m.serviceId] || m.serviceId)}</td><td>${m.month}</td>
    <td class="num">${fmtPct(m.availabilityPercent)}</td>
    <td><span class="badge ${cls(m.meetsSla)}">${m.meetsSla === null ? 'no data' : m.meetsSla ? 'meets' : 'breach'}</span></td>
    <td class="num">${fmtDur(m.downtimeMinutes)}</td>
    <td class="num">${m.coveragePercent >= 99.9 ? 'full month' : m.coveragePercent + '% of month'}</td></tr>`).join('');
  const months = `<h3>Monthly SLA (calendar month, UTC)</h3><div class="scroll"><table>
    <thead><tr><th>Service</th><th>Month</th><th class="num">Availability</th><th>Verdict</th><th class="num">Downtime</th><th class="num">Data coverage</th></tr></thead>
    <tbody>${monthRows}</tbody></table></div>
    <p class="muted" style="font-size:12px;margin:6px 0 0">Partial months are indicative only — the credit decision needs a full month of data.</p>`;

  const incRows = s.incidents.slice(0, 8).map((i) => `<tr>
    <td>${esc(i.serviceName)}</td><td class="mono">${esc(fmtTs(i.start))}</td><td class="num">${fmtDur(i.durationMinutes)}</td><td class="num">${i.failedChecks}</td></tr>`).join('');
  const incidents = `<h3>Longest incidents <span class="muted" style="font-weight:400">(consecutive failed checks)</span></h3>${
    s.incidents.length ? `<div class="scroll"><table><thead><tr><th>Service</th><th>Started (UTC)</th><th class="num">Duration</th><th class="num">Failed checks</th></tr></thead><tbody>${incRows}</tbody></table></div>` : '<p class="muted">No failed checks in this period.</p>'}`;

  const codes = Object.entries(s.statusCodes).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="badge ${k === '200' ? 'up' : k === 'invalid' || k === '999' ? 'unknown' : 'down'}">${esc(k)}: ${fmtInt(v)}</span>`).join(' ');

  const up = state.uploads.find((u) => u.id === state.upload);
  const dq = up ? `<details style="margin-top:16px"><summary><strong>Data quality — what the pipeline fixed</strong> <span class="muted">(${esc(up.filename)})</span></summary><div style="padding-top:8px">${dataQualityHtml(up.summary)}</div></details>` : '';

  $('stats-body').innerHTML = kpis + svcTable +
    `<div class="grid2"><div>${daily}</div><div>${incidents}<h3>Status codes</h3><div>${codes}</div></div></div>` + months + dq;
}

async function loadStats() {
  const p = periodParams();
  if (!p) return;
  p.set('upload', state.upload);
  const seq = ++state.reqSeq.stats;
  $('stats-sub').textContent = periodLabel();
  try {
    const s = await api(`/api/stats?${p}`);
    if (seq === state.reqSeq.stats) renderStats(s);
  } catch (e) {
    if (seq === state.reqSeq.stats) $('stats-body').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

// -------------------------------------------------------------------- logs

async function loadLogs() {
  const p = periodParams();
  if (!p) return;
  p.set('upload', state.upload);
  p.set('page', state.page);
  p.set('pageSize', $('f-size').value);
  if ($('f-service').value) p.set('service', $('f-service').value);
  if ($('f-outcome').value) p.set('outcome', $('f-outcome').value);
  const seq = ++state.reqSeq.logs;
  $('logs-msg').innerHTML = '';
  try {
    const r = await api(`/api/logs?${p}`);
    if (seq !== state.reqSeq.logs) return;
    $('logs-count').textContent = `${fmtInt(r.total)} record${r.total === 1 ? '' : 's'}`;
    $('logs-body').innerHTML = r.rows.map((x) => `<tr>
      <td class="mono">${esc(fmtTs(x.ts))}</td>
      <td>${esc(x.serviceName)}</td>
      <td class="num">${x.statusCode ?? '—'}</td>
      <td><span class="badge ${x.outcome}">${x.outcome}</span></td>
      <td class="num">${fmtMs(x.latencyMs)}</td>
      <td>${esc(x.agent)}</td><td>${esc(x.region)}</td><td class="num">${x.reports}</td></tr>`).join('');
    if (!r.rows.length) $('logs-msg').innerHTML = '<div class="empty muted">No records match these filters.</div>';
    $('page-info').textContent = `Page ${r.page} of ${r.totalPages}`;
    $('prev').disabled = r.page <= 1;
    $('next').disabled = r.page >= r.totalPages;
    state.page = r.page;
  } catch (e) {
    if (seq === state.reqSeq.logs) $('logs-msg').innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}

function refresh() {
  loadStats();
  loadLogs();
}

// -------------------------------------------------------------------- boot

function applyUpload(u) {
  state.upload = u.id;
  state.page = 1;
  try { localStorage.setItem('sla.upload', u.id); } catch {}
  const r = u.summary.range;
  if (r) {
    const min = r.from.slice(0, 10), max = r.to.slice(0, 10);
    for (const id of ['date', 'from', 'to']) { $(id).min = min; $(id).max = max; }
    if (!$('date').value) $('date').value = min;
  }
  $('f-service').innerHTML = '<option value="">All services</option>' +
    u.summary.services.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
}

async function boot() {
  try {
    const { uploads } = await api('/api/uploads');
    state.uploads = uploads;
    if (!uploads.length) { $('empty').hidden = false; return; }

    let wanted = new URLSearchParams(location.search).get('upload');
    try { wanted ||= localStorage.getItem('sla.upload'); } catch {}
    const current = uploads.find((u) => u.id === wanted) || uploads[0];

    $('dataset').innerHTML = uploads.map((u) =>
      `<option value="${esc(u.id)}">${esc(u.filename)} — ${esc(u.uploadedAt.slice(0, 16).replace('T', ' '))}Z</option>`).join('');
    $('dataset').value = current.id;
    applyUpload(current);
    $('app').hidden = false;
    refresh();
  } catch (e) {
    $('fatal').hidden = false;
    $('fatal').textContent = `Could not load the dashboard: ${e.message}`;
  }
}

$('dataset').addEventListener('change', (e) => {
  applyUpload(state.uploads.find((u) => u.id === e.target.value));
  refresh();
});
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', onModeChange));
for (const id of ['date', 'from', 'to']) $(id).addEventListener('change', () => { state.page = 1; refresh(); });
for (const id of ['f-service', 'f-outcome', 'f-size']) $(id).addEventListener('change', () => { state.page = 1; loadLogs(); });
$('prev').addEventListener('click', () => { state.page--; loadLogs(); });
$('next').addEventListener('click', () => { state.page++; loadLogs(); });
$('stats-toggle').addEventListener('click', () => {
  const t = $('stats-toggle');
  const open = t.getAttribute('aria-expanded') === 'true';
  t.setAttribute('aria-expanded', String(!open));
  $('stats-body').hidden = open;
});
boot();
