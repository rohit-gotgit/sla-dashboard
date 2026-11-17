import { parseCsv } from './csv';
import {
  CheckRecord,
  CleanResult,
  CleaningSummary,
  Outcome,
  RejectedRow,
  ValidationError,
} from './types';

export const SLOT_MS = 15 * 60 * 1000;
export const REQUIRED_COLUMNS = [
  'service_id',
  'service_name',
  'timestamp',
  'status_code',
  'latency',
  'latency_unit',
  'agent',
  'region',
] as const;

// ---------------------------------------------------------------- timestamps

export type TimestampFormat = 'iso_utc' | 'iso_offset' | 'iso_naive' | 'epoch_s' | 'epoch_ms';

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Parses the timestamp formats seen in the logs into UTC epoch milliseconds.
 * - 2025-05-13T12:45:00Z          ISO, UTC
 * - 2025-05-26T11:15:00+05:30     ISO with offset  -> converted to UTC
 * - 1746938700 / 1746938700000    epoch seconds / milliseconds
 * - 2025-05-13T12:45:00           no zone -> assumed UTC (flagged separately)
 * Returns null for anything unparseable or calendar-invalid (e.g. Feb 30).
 */
export function parseTimestamp(raw: string): { ms: number; format: TimestampFormat } | null {
  const s = raw.trim();
  if (/^\d{10}$/.test(s)) return { ms: Number(s) * 1000, format: 'epoch_s' };
  if (/^\d{13}$/.test(s)) return { ms: Number(s), format: 'epoch_ms' };

  const m = ISO_RE.exec(s);
  if (!m) return null;
  const [, y, mo, d, h, mi, sec = '0', zone] = m;
  const Y = +y, MO = +mo, D = +d, H = +h, MI = +mi, S = +sec;
  const wall = Date.UTC(Y, MO - 1, D, H, MI, S);
  const check = new Date(wall);
  // Date.UTC silently rolls invalid dates over; reject those.
  if (
    check.getUTCFullYear() !== Y || check.getUTCMonth() !== MO - 1 || check.getUTCDate() !== D ||
    H > 23 || MI > 59 || S > 59
  ) {
    return null;
  }
  if (!zone) return { ms: wall, format: 'iso_naive' };
  if (zone.toUpperCase() === 'Z') return { ms: wall, format: 'iso_utc' };
  const sign = zone[0] === '-' ? -1 : 1;
  const digits = zone.slice(1).replace(':', '');
  const offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
  // wall-clock time at +05:30 is 5h30m *ahead* of UTC, so subtract the offset.
  return { ms: wall - offsetMin * 60_000, format: 'iso_offset' };
}

// ------------------------------------------------------------------- latency

const UNIT_FACTORS: Record<string, number> = {
  ms: 1,
  msec: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
};

type LatencyResult =
  | { kind: 'ok'; ms: number; converted: boolean }
  | { kind: 'missing' }
  | { kind: 'invalid' }
  | { kind: 'unknown_unit' };

export function parseLatency(rawValue: string, rawUnit: string): LatencyResult {
  const v = rawValue.trim();
  if (v === '') return { kind: 'missing' };
  if (!/^-?\d+(\.\d+)?$/.test(v)) return { kind: 'invalid' };
  const n = Number(v);
  if (n < 0) return { kind: 'invalid' }; // a duration cannot be negative
  const factor = UNIT_FACTORS[rawUnit.trim().toLowerCase()];
  if (factor === undefined) return { kind: 'unknown_unit' };
  // round to 1µs to remove float noise such as 0.717 * 1000 = 717.0000000000001
  return { kind: 'ok', ms: Math.round(n * factor * 1000) / 1000, converted: factor !== 1 };
}

// -------------------------------------------------------------------- status

export function parseStatus(raw: string): { code: number | null; outcome: Outcome } {
  const s = raw.trim();
  if (!/^\d{3}$/.test(s)) return { code: null, outcome: 'unknown' };
  const code = Number(s);
  if (code < 100 || code > 599) return { code, outcome: 'unknown' }; // e.g. 999
  return { code, outcome: code >= 500 ? 'down' : 'up' };
}

// ------------------------------------------------------------------ pipeline

interface Candidate extends Omit<CheckRecord, 'reports'> {
  row: number;
}

/**
 * Picks the record that should represent a (service, timestamp) slot:
 *  1. a row with a valid status beats one without
 *  2. if two valid rows disagree on up/down, the failure wins (never hide an outage)
 *  3. a row that has a latency beats one without
 *  4. lowest agent id, then earliest row, so the result is deterministic
 */
function preferred(a: Candidate, b: Candidate): Candidate {
  const aValid = a.outcome !== 'unknown';
  const bValid = b.outcome !== 'unknown';
  if (aValid !== bValid) return aValid ? a : b;
  if (aValid && a.outcome !== b.outcome) return a.outcome === 'down' ? a : b;
  const aLat = a.latencyMs !== null;
  const bLat = b.latencyMs !== null;
  if (aLat !== bLat) return aLat ? a : b;
  if (a.agent !== b.agent) return a.agent < b.agent ? a : b;
  return a.row <= b.row ? a : b;
}

function bump(map: Record<string, number>, key: string, by = 1) {
  map[key] = (map[key] ?? 0) + by;
}

export function cleanCsv(text: string): CleanResult {
  const records = parseCsv(text);
  if (records.length === 0) throw new ValidationError('The file is empty.');

  const header = records[0].cells.map((h) => h.trim().toLowerCase());
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new ValidationError(`Missing required column(s): ${missing.join(', ')}`);
  }
  const col = Object.fromEntries(REQUIRED_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<
    (typeof REQUIRED_COLUMNS)[number],
    number
  >;

  const summary: CleaningSummary = {
    rowsReceived: records.length - 1,
    rowsRejected: 0,
    rejectedByReason: {},
    checksStored: 0,
    duplicateRowsMerged: 0,
    conflictingDuplicateGroups: 0,
    timestampFormats: {},
    timestampsNormalizedToUtc: 0,
    latencyConvertedFromSeconds: 0,
    latencyMissing: 0,
    latencyInvalid: 0,
    unknownLatencyUnit: 0,
    invalidStatusRows: 0,
    offGridTimestamps: 0,
    services: [],
    range: null,
    expectedChecksPerService: 0,
    missingSlotsByService: {},
  };
  const rejected: RejectedRow[] = [];
  const reject = (row: number, reason: string, cells: string[]) => {
    summary.rowsRejected++;
    bump(summary.rejectedByReason, reason);
    rejected.push({ row, reason, raw: cells.join(',') });
  };

  const groups = new Map<string, { best: Candidate; count: number; conflict: boolean }>();
  const nameVotes = new Map<string, Record<string, number>>();

  for (const rec of records.slice(1)) {
    const { row, cells } = rec;
    if (cells.length !== header.length) {
      reject(row, 'column_count_mismatch', cells);
      continue;
    }
    const get = (c: (typeof REQUIRED_COLUMNS)[number]) => cells[col[c]] ?? '';

    const serviceId = get('service_id').trim().toLowerCase();
    if (!serviceId) {
      reject(row, 'missing_service_id', cells);
      continue;
    }
    const ts = parseTimestamp(get('timestamp'));
    if (!ts) {
      reject(row, 'invalid_timestamp', cells);
      continue;
    }

    bump(summary.timestampFormats, ts.format);
    if (ts.format !== 'iso_utc') summary.timestampsNormalizedToUtc++;
    if (ts.ms % SLOT_MS !== 0) summary.offGridTimestamps++;

    const status = parseStatus(get('status_code'));
    if (status.outcome === 'unknown') summary.invalidStatusRows++;

    const lat = parseLatency(get('latency'), get('latency_unit'));
    let latencyMs: number | null = null;
    if (lat.kind === 'ok') {
      latencyMs = lat.ms;
      if (lat.converted) summary.latencyConvertedFromSeconds++;
    } else if (lat.kind === 'missing') summary.latencyMissing++;
    else if (lat.kind === 'invalid') summary.latencyInvalid++;
    else summary.unknownLatencyUnit++;

    const name = get('service_name').trim();
    if (name) {
      const votes = nameVotes.get(serviceId) ?? {};
      bump(votes, name);
      nameVotes.set(serviceId, votes);
    }

    const cand: Candidate = {
      row,
      serviceId,
      serviceName: name,
      ts: new Date(ts.ms).toISOString(),
      tsMs: ts.ms,
      statusCode: status.code,
      outcome: status.outcome,
      latencyMs,
      agent: get('agent').trim().toLowerCase(),
      region: get('region').trim().toLowerCase(),
    };

    const key = `${serviceId}|${ts.ms}`;
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { best: cand, count: 1, conflict: false });
    } else {
      const bothValid = existing.best.outcome !== 'unknown' && cand.outcome !== 'unknown';
      if (bothValid && existing.best.outcome !== cand.outcome) existing.conflict = true;
      existing.best = preferred(existing.best, cand);
      existing.count++;
    }
  }

  // canonical service_name = most common non-empty name seen for that id
  const canonicalName = new Map<string, string>();
  for (const [id, votes] of nameVotes) {
    canonicalName.set(id, Object.entries(votes).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0]);
  }

  const out: CheckRecord[] = [];
  for (const g of groups.values()) {
    if (g.conflict) summary.conflictingDuplicateGroups++;
    summary.duplicateRowsMerged += g.count - 1;
    const { row: _row, ...rest } = g.best;
    out.push({
      ...rest,
      serviceName: canonicalName.get(rest.serviceId) ?? rest.serviceId,
      reports: g.count,
    });
  }
  out.sort((a, b) => a.tsMs - b.tsMs || (a.serviceId < b.serviceId ? -1 : 1));
  summary.checksStored = out.length;

  // ---- coverage: which 15-minute slots are missing per service?
  summary.services = [...new Set(out.map((r) => r.serviceId))].sort();
  if (out.length) {
    const first = out[0].tsMs;
    const last = out[out.length - 1].tsMs;
    summary.range = { from: new Date(first).toISOString(), to: new Date(last).toISOString() };
    const start = Math.ceil(first / SLOT_MS) * SLOT_MS;
    const slots = Math.floor((last - start) / SLOT_MS) + 1;
    summary.expectedChecksPerService = slots;
    for (const svc of summary.services) {
      const have = new Set<number>();
      for (const r of out) if (r.serviceId === svc) have.add(r.tsMs);
      let missingCount = 0;
      for (let i = 0; i < slots; i++) if (!have.has(start + i * SLOT_MS)) missingCount++;
      summary.missingSlotsByService[svc] = missingCount;
    }
  }

  return { records: out, rejected, summary };
}
