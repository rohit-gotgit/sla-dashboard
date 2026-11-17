/** Cleans every CSV in ./data and prints a JSON report (used to cross-check against an independent implementation). */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanCsv } from '../lib/clean';
import { computeStats } from '../lib/stats';

const dir = join(__dirname, '..', 'data');
const report: Record<string, unknown> = {};
for (const f of readdirSync(dir).filter((n) => n.endsWith('.csv')).sort()) {
  const t0 = Date.now();
  const { records, summary } = cleanCsv(readFileSync(join(dir, f), 'utf8'));
  const stats = computeStats(records.map((r) => ({ ...r })));
  report[f] = {
    ms: Date.now() - t0,
    summary,
    services: Object.fromEntries(
      stats.services.map((s) => [s.serviceId, { up: s.up, down: s.down, unknown: s.unknown, avail: s.availabilityPercent, p50: s.latencyP50, p95: s.latencyP95, incidents: s.incidentCount }]),
    ),
  };
}
console.log(JSON.stringify(report, null, 1));
