import { SLOT_MS } from './clean';

export const SLA_TARGET_PERCENT = 99.9;
/** integer form of the target so threshold comparisons are exact: up/counted >= 999/1000 */
const TARGET_NUM = 999;
const TARGET_DEN = 1000;

export interface StatRow {
  serviceId: string;
  serviceName: string;
  tsMs: number;
  statusCode: number | null;
  outcome: 'up' | 'down' | 'unknown';
  latencyMs: number | null;
}

export interface Incident {
  serviceId: string;
  serviceName: string;
  start: string;
  /** end of the last failed 15-minute check window */
  end: string;
  failedChecks: number;
  durationMinutes: number;
}

export interface ServiceStats {
  serviceId: string;
  serviceName: string;
  checks: number;
  up: number;
  down: number;
  unknown: number;
  availabilityPercent: number | null;
  meetsSla: boolean | null;
  downtimeMinutes: number;
  allowedDowntimeMinutes: number;
  errorBudgetRemainingMinutes: number;
  incidentCount: number;
  longestOutageMinutes: number;
  latencyP50: number | null;
  latencyP95: number | null;
  latencyMax: number | null;
}

export interface MonthStats {
  serviceId: string;
  month: string; // YYYY-MM (UTC)
  checks: number;
  down: number;
  availabilityPercent: number | null;
  meetsSla: boolean | null;
  downtimeMinutes: number;
  /** counted checks / checks a full month would have; <100 means the data covers part of the month */
  coveragePercent: number;
}

export interface DayCell {
  day: string; // YYYY-MM-DD (UTC)
  availabilityPercent: number | null;
  checks: number;
  down: number;
}

export interface Stats {
  targetPercent: number;
  slotMinutes: number;
  overall: {
    checks: number;
    up: number;
    down: number;
    unknown: number;
    availabilityPercent: number | null;
    servicesBreaching: number;
    services: number;
    from: string | null;
    to: string | null;
  };
  services: ServiceStats[];
  months: MonthStats[];
  daily: Record<string, DayCell[]>;
  incidents: Incident[];
  statusCodes: Record<string, number>;
}

const round = (n: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/** nearest-rank percentile on an ascending-sorted array */
export function percentile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function availability(up: number, down: number) {
  const counted = up + down;
  if (counted === 0) return { pct: null, meets: null };
  return {
    pct: round((up / counted) * 100, 3),
    meets: up * TARGET_DEN >= counted * TARGET_NUM,
  };
}

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const monthKey = (ms: number) => new Date(ms).toISOString().slice(0, 7);
const daysInMonth = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

/**
 * Availability = up / (up + down). Checks with an invalid status ("unknown") and
 * slots with no data are excluded from the denominator: we don't know whether
 * the service was up, so we neither credit nor penalise it.
 * Each check represents one 15-minute window, so downtime = failed checks x 15 min.
 */
export function computeStats(rows: StatRow[]): Stats {
  const byService = new Map<string, StatRow[]>();
  for (const r of rows) {
    const list = byService.get(r.serviceId) ?? [];
    list.push(r);
    byService.set(r.serviceId, list);
  }

  const services: ServiceStats[] = [];
  const months: MonthStats[] = [];
  const daily: Record<string, DayCell[]> = {};
  const incidents: Incident[] = [];
  const statusCodes: Record<string, number> = {};
  const slotMin = SLOT_MS / 60000;
  let totUp = 0, totDown = 0, totUnknown = 0;
  let minTs = Infinity, maxTs = -Infinity;

  for (const id of [...byService.keys()].sort()) {
    const list = byService.get(id)!.slice().sort((a, b) => a.tsMs - b.tsMs);
    let up = 0, down = 0, unknown = 0;
    const latencies: number[] = [];
    const monthAgg = new Map<string, { up: number; down: number }>();
    const dayAgg = new Map<string, { up: number; down: number }>();

    // outage runs: consecutive 15-minute slots that are all "down"
    let runStart = -1, runLast = -1, runLen = 0;
    const svcIncidents: Incident[] = [];
    const closeRun = () => {
      if (runLen > 0) {
        svcIncidents.push({
          serviceId: id,
          serviceName: list[0].serviceName,
          start: new Date(runStart).toISOString(),
          end: new Date(runLast + SLOT_MS).toISOString(),
          failedChecks: runLen,
          durationMinutes: runLen * slotMin,
        });
      }
      runLen = 0;
    };

    for (const r of list) {
      minTs = Math.min(minTs, r.tsMs);
      maxTs = Math.max(maxTs, r.tsMs);
      const key = r.statusCode === null ? 'invalid' : String(r.statusCode);
      statusCodes[key] = (statusCodes[key] ?? 0) + 1;
      if (r.latencyMs !== null) latencies.push(r.latencyMs);

      if (r.outcome === 'unknown') {
        unknown++;
        closeRun();
        continue;
      }
      const m = monthAgg.get(monthKey(r.tsMs)) ?? { up: 0, down: 0 };
      const d = dayAgg.get(dayKey(r.tsMs)) ?? { up: 0, down: 0 };
      if (r.outcome === 'up') {
        up++; m.up++; d.up++;
        closeRun();
      } else {
        down++; m.down++; d.down++;
        if (runLen > 0 && r.tsMs - runLast === SLOT_MS) {
          runLen++;
        } else {
          closeRun();
          runStart = r.tsMs;
          runLen = 1;
        }
        runLast = r.tsMs;
      }
      monthAgg.set(monthKey(r.tsMs), m);
      dayAgg.set(dayKey(r.tsMs), d);
    }
    closeRun();

    latencies.sort((a, b) => a - b);
    const av = availability(up, down);
    const counted = up + down;
    const allowed = round(((TARGET_DEN - TARGET_NUM) / TARGET_DEN) * counted * slotMin, 2);
    const downtime = down * slotMin;
    services.push({
      serviceId: id,
      serviceName: list[0].serviceName,
      checks: list.length,
      up, down, unknown,
      availabilityPercent: av.pct,
      meetsSla: av.meets,
      downtimeMinutes: downtime,
      allowedDowntimeMinutes: allowed,
      errorBudgetRemainingMinutes: round(allowed - downtime, 2),
      incidentCount: svcIncidents.length,
      longestOutageMinutes: svcIncidents.reduce((mx, i) => Math.max(mx, i.durationMinutes), 0),
      latencyP50: percentile(latencies, 50),
      latencyP95: percentile(latencies, 95),
      latencyMax: latencies.length ? latencies[latencies.length - 1] : null,
    });
    incidents.push(...svcIncidents);

    for (const [month, a] of [...monthAgg.entries()].sort()) {
      const mav = availability(a.up, a.down);
      months.push({
        serviceId: id,
        month,
        checks: a.up + a.down,
        down: a.down,
        availabilityPercent: mav.pct,
        meetsSla: mav.meets,
        downtimeMinutes: a.down * slotMin,
        coveragePercent: round(((a.up + a.down) / (daysInMonth(month) * 24 * (60 / slotMin))) * 100, 1),
      });
    }
    daily[id] = [...dayAgg.entries()].sort().map(([day, a]) => ({
      day,
      availabilityPercent: availability(a.up, a.down).pct,
      checks: a.up + a.down,
      down: a.down,
    }));

    totUp += up; totDown += down; totUnknown += unknown;
  }

  incidents.sort((a, b) => b.durationMinutes - a.durationMinutes || (a.start < b.start ? 1 : -1));
  const overall = availability(totUp, totDown);
  return {
    targetPercent: SLA_TARGET_PERCENT,
    slotMinutes: slotMin,
    overall: {
      checks: totUp + totDown + totUnknown,
      up: totUp,
      down: totDown,
      unknown: totUnknown,
      availabilityPercent: overall.pct,
      servicesBreaching: services.filter((s) => s.meetsSla === false).length,
      services: services.length,
      from: rows.length ? new Date(minTs).toISOString() : null,
      to: rows.length ? new Date(maxTs).toISOString() : null,
    },
    services,
    months,
    daily,
    incidents,
    statusCodes,
  };
}
