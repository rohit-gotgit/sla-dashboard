import { createServer, Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setDb } from '../lib/db';
import { pgliteDb } from '../lib/pglite-adapter';
import upload from '../api/upload';
import uploads from '../api/uploads';
import stats from '../api/stats';
import logs from '../api/logs';

const routes: Record<string, (req: any, res: any) => Promise<void>> = { upload, uploads, stats, logs };
let server: Server;
let base: string;
const csv = readFileSync(join(__dirname, '..', 'data', 'monitoring_checks_9d_seed101.csv'), 'utf8');

beforeAll(async () => {
  setDb(pgliteDb(new PGlite()));
  server = createServer((req, res) => {
    const name = new URL(req.url!, 'http://x').pathname.slice(5);
    routes[name](req, res);
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});
afterAll(() => {
  server.close();
  setDb(null);
});

const post = (body: string, name = 'sample.csv') =>
  fetch(`${base}/upload`, { method: 'POST', body, headers: { 'Content-Type': 'text/plain', 'x-filename': name } });

describe('API end to end (embedded Postgres)', () => {
  let uploadId: string;

  it('uploads, cleans and persists a CSV', async () => {
    const res = await post(csv);
    expect(res.status).toBe(201);
    const j = await res.json();
    uploadId = j.uploadId;
    expect(j.summary.rowsReceived).toBe(4672);
    expect(j.summary.checksStored).toBe(864 * 5);
    expect(j.summary.rowsRejected).toBe(0);
    expect(Object.values(j.summary.missingSlotsByService).every((n) => n === 0)).toBe(true);
  });

  it('is idempotent for identical content', async () => {
    const res = await post(csv);
    expect(res.status).toBe(200);
    expect((await res.json()).uploadId).toBe(uploadId);
    const list = await (await fetch(`${base}/uploads`)).json();
    expect(list.uploads).toHaveLength(1);
  });

  it('rejects bad input cleanly', async () => {
    expect((await post('')).status).toBe(400);
    expect((await post('a,b\n1,2')).status).toBe(422);
    expect((await fetch(`${base}/upload`)).status).toBe(405);
  });

  it('serves stats that survive after the upload request finished', async () => {
    const s = await (await fetch(`${base}/stats?upload=${uploadId}`)).json();
    expect(s.services).toHaveLength(5);
    expect(s.overall.unknown).toBe(1); // the single 999 status
    expect(s.overall.checks).toBe(4320);
  });

  it('filters logs by single date, range, service and outcome', async () => {
    const one = await (await fetch(`${base}/logs?upload=${uploadId}&date=2025-05-10&pageSize=200`)).json();
    expect(one.total).toBe(96 * 5);
    expect(one.rows.every((r: any) => r.ts.startsWith('2025-05-10'))).toBe(true);

    const range = await (await fetch(`${base}/logs?upload=${uploadId}&from=2025-05-10&to=2025-05-11`)).json();
    expect(range.total).toBe(96 * 5 * 2);

    const down = await (await fetch(`${base}/logs?upload=${uploadId}&outcome=down&service=svc-reports`)).json();
    expect(down.total).toBeGreaterThan(0);
    expect(down.rows.every((r: any) => r.outcome === 'down' && r.serviceId === 'svc-reports')).toBe(true);

    const scoped = await (await fetch(`${base}/stats?upload=${uploadId}&date=2025-05-10`)).json();
    expect(scoped.overall.checks).toBe(96 * 5);
  });

  it('validates query params', async () => {
    expect((await fetch(`${base}/logs?upload=nope`)).status).toBe(400);
    expect((await fetch(`${base}/logs?upload=${uploadId}&date=2025-02-30`)).status).toBe(400);
    expect((await fetch(`${base}/logs?upload=${uploadId}&date=2025-05-10&from=2025-05-01`)).status).toBe(400);
    expect((await fetch(`${base}/logs?upload=${uploadId}&from=2025-05-12&to=2025-05-01`)).status).toBe(400);
    expect((await fetch(`${base}/logs?upload=${uploadId}&pageSize=9999`)).status).toBe(400);
    expect((await fetch(`${base}/stats?upload=00000000-0000-4000-8000-000000000000`)).status).toBe(404);
  });
});
