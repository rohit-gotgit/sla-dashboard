import { describe, expect, it } from 'vitest';
import { computeStats, percentile, StatRow } from '../lib/stats';

const T0 = Date.UTC(2025, 4, 1);
const SLOT = 15 * 60_000;
const mk = (i: number, outcome: StatRow['outcome'], lat: number | null = 100, id = 'svc-a'): StatRow => ({
  serviceId: id, serviceName: id + '-name', tsMs: T0 + i * SLOT,
  statusCode: outcome === 'up' ? 200 : outcome === 'down' ? 503 : 999, outcome, latencyMs: lat,
});

describe('percentile', () => {
  it('uses nearest-rank', () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(s, 50)).toBe(5);
    expect(percentile(s, 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe('computeStats', () => {
  it('computes availability, downtime and SLA verdict with exact threshold maths', () => {
    // 1000 counted checks, 1 failure => exactly 99.9% => meets SLA (>=)
    const rows = Array.from({ length: 1000 }, (_, i) => mk(i, i === 10 ? 'down' : 'up'));
    const s = computeStats(rows).services[0];
    expect(s.availabilityPercent).toBe(99.9);
    expect(s.meetsSla).toBe(true);
    expect(s.downtimeMinutes).toBe(15);
    // 2 failures => 99.8% => breach
    rows[20] = mk(20, 'down');
    expect(computeStats(rows).services[0].meetsSla).toBe(false);
  });

  it('excludes unknown-status checks from the denominator', () => {
    const rows = [mk(0, 'up'), mk(1, 'unknown'), mk(2, 'down'), mk(3, 'up')];
    const { services, overall } = computeStats(rows);
    expect(services[0]).toMatchObject({ up: 2, down: 1, unknown: 1, availabilityPercent: 66.667 });
    expect(overall.checks).toBe(4);
  });

  it('groups consecutive failures into incidents and breaks runs on gaps / successes', () => {
    const rows = [mk(0, 'down'), mk(1, 'down'), mk(2, 'down'), mk(3, 'up'), mk(5, 'down'), mk(7, 'down'), mk(8, 'down')];
    const { incidents, services } = computeStats(rows);
    expect(incidents.map((i) => i.failedChecks).sort()).toEqual([1, 2, 3]);
    expect(incidents[0]).toMatchObject({ failedChecks: 3, durationMinutes: 45 });
    expect(incidents[0].end).toBe(new Date(T0 + 3 * SLOT).toISOString());
    expect(services[0].longestOutageMinutes).toBe(45);
  });

  it('splits SLA by UTC calendar month and reports partial coverage', () => {
    const lastApr = Date.UTC(2025, 3, 30, 23, 45);
    const rows: StatRow[] = [
      { ...mk(0, 'up'), tsMs: lastApr },
      { ...mk(0, 'down'), tsMs: lastApr + SLOT }, // 2025-05-01T00:00Z
    ];
    const { months } = computeStats(rows);
    expect(months.map((m) => [m.month, m.availabilityPercent])).toEqual([['2025-04', 100], ['2025-05', 0]]);
    expect(months[0].coveragePercent).toBeLessThan(1);
  });

  it('handles empty input', () => {
    const s = computeStats([]);
    expect(s.overall.availabilityPercent).toBeNull();
    expect(s.services).toEqual([]);
  });
});
