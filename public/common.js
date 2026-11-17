/* shared helpers */
function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const nf = new Intl.NumberFormat('en-US');
const fmtInt = (n) => nf.format(n);
const fmtPct = (n) => (n === null || n === undefined ? '—' : n.toFixed(3) + '%');
const fmtMs = (n) => (n === null || n === undefined ? '—' : nf.format(Math.round(n * 10) / 10));
const fmtTs = (iso) => iso.replace('T', ' ').replace(/:00\.000Z$/, 'Z').replace('.000Z', 'Z');
const fmtDur = (min) => (min >= 60 ? `${Math.floor(min / 60)}h ${min % 60}m` : `${min}m`);
async function api(path, opts) {
  const res = await fetch(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body;
}
function dataQualityHtml(s) {
  const row = (k, v) => `<dt>${esc(k)}</dt><dd>${v}</dd>`;
  const missing = Object.values(s.missingSlotsByService).reduce((a, b) => a + b, 0);
  const rej = Object.entries(s.rejectedByReason).map(([k, v]) => `${esc(k)}: ${v}`).join(', ') || 'none';
  return `<dl class="dq">
    ${row('Rows received', fmtInt(s.rowsReceived))}
    ${row('Unique checks stored', fmtInt(s.checksStored) + ` (${s.services.length} services × ${fmtInt(s.expectedChecksPerService)} slots)`)}
    ${row('Duplicate rows merged', fmtInt(s.duplicateRowsMerged) + (s.conflictingDuplicateGroups ? ` (${s.conflictingDuplicateGroups} conflicting → kept failure)` : ''))}
    ${row('Timestamps normalised to UTC', fmtInt(s.timestampsNormalizedToUtc) + ' ' + esc(JSON.stringify(s.timestampFormats)))}
    ${row('Latency converted s → ms', fmtInt(s.latencyConvertedFromSeconds))}
    ${row('Latency missing / invalid', `${fmtInt(s.latencyMissing)} / ${fmtInt(s.latencyInvalid)} (stored as empty)`)}
    ${row('Invalid status codes', fmtInt(s.invalidStatusRows) + ' (excluded from availability)')}
    ${row('Rows rejected', fmtInt(s.rowsRejected) + ' — ' + rej)}
    ${row('Missing 15-min slots', fmtInt(missing))}
    ${row('Coverage (UTC)', s.range ? `${esc(fmtTs(s.range.from))} → ${esc(fmtTs(s.range.to))}` : '—')}
  </dl>`;
}
