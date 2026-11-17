import { createHash, randomUUID } from 'node:crypto';
import { CleanResult, CleaningSummary } from './types';
import { StatRow } from './stats';

/** Smallest surface we need from a Postgres client (satisfied by `pg` and PGlite). */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}
export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
}

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS uploads (
  id           uuid PRIMARY KEY,
  filename     text NOT NULL,
  content_hash text NOT NULL UNIQUE,
  uploaded_at  timestamptz NOT NULL DEFAULT now(),
  summary      jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS checks (
  upload_id    uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  service_id   text NOT NULL,
  service_name text NOT NULL,
  ts           timestamptz NOT NULL,
  status_code  integer,
  outcome      text NOT NULL CHECK (outcome IN ('up','down','unknown')),
  latency_ms   double precision,
  agent        text NOT NULL,
  region       text NOT NULL,
  reports      integer NOT NULL,
  PRIMARY KEY (upload_id, service_id, ts)
);
CREATE INDEX IF NOT EXISTS checks_upload_ts_idx ON checks (upload_id, ts);
CREATE TABLE IF NOT EXISTS rejected_rows (
  upload_id uuid NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
  row_number integer NOT NULL,
  reason    text NOT NULL,
  raw       text NOT NULL
);
`;

let schemaReady: Promise<void> | null = null;
export function ensureSchema(db: Db): Promise<void> {
  // idempotent (IF NOT EXISTS) so there is no separate migration step to forget
  schemaReady ??= (async () => {
    // one statement per call: works on both `pg` and PGlite's extended protocol
    for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  })().catch((e) => {
    schemaReady = null;
    throw e;
  });
  return schemaReady;
}

let injected: Db | null = null;
let pool: Db | null = null;
/** used by the local dev server / tests to supply an embedded Postgres */
export function setDb(db: Db | null) {
  injected = db;
  schemaReady = null;
}

export async function getDb(): Promise<Db> {
  const db = injected ?? (pool ??= await createPgDb());
  await ensureSchema(db);
  return db;
}

async function createPgDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const { Pool } = await import('pg');
  const p = new Pool({ connectionString: url, max: 1, idleTimeoutMillis: 10_000 });
  return {
    query: (text, params) => p.query(text, params as any[]),
    async transaction(fn) {
      const client = await p.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ query: (t, pr) => client.query(t, pr as any[]) });
        await client.query('COMMIT');
        return result;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };
}

// ------------------------------------------------------------------- writes

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface SavedUpload {
  id: string;
  filename: string;
  summary: CleaningSummary;
  alreadyUploaded: boolean;
}

const CHUNK = 2000;
const REJECTED_CAP = 500;

/**
 * Persists a cleaned upload atomically (all rows or none). Uploading byte-identical
 * content again returns the existing upload instead of creating a duplicate.
 */
export async function saveUpload(
  db: Db,
  filename: string,
  rawText: string,
  cleaned: CleanResult,
): Promise<SavedUpload> {
  const hash = sha256(rawText);
  const existing = await db.query('SELECT id, filename, summary FROM uploads WHERE content_hash = $1', [hash]);
  if (existing.rows.length) {
    const r = existing.rows[0];
    return { id: r.id, filename: r.filename, summary: r.summary, alreadyUploaded: true };
  }

  const id = randomUUID();
  await db.transaction(async (tx) => {
    await tx.query('INSERT INTO uploads (id, filename, content_hash, summary) VALUES ($1, $2, $3, $4)', [
      id, filename, hash, JSON.stringify(cleaned.summary),
    ]);
    const recs = cleaned.records;
    for (let i = 0; i < recs.length; i += CHUNK) {
      const c = recs.slice(i, i + CHUNK);
      await tx.query(
        `INSERT INTO checks (upload_id, service_id, service_name, ts, status_code, outcome, latency_ms, agent, region, reports)
         SELECT $1::uuid, t.a, t.b, t.c::timestamptz, t.d, t.e, t.f, t.g, t.h, t.i
         FROM unnest($2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::float8[], $8::text[], $9::text[], $10::int[])
           AS t(a, b, c, d, e, f, g, h, i)`,
        [
          id,
          c.map((r) => r.serviceId),
          c.map((r) => r.serviceName),
          c.map((r) => r.ts),
          c.map((r) => r.statusCode),
          c.map((r) => r.outcome),
          c.map((r) => r.latencyMs),
          c.map((r) => r.agent),
          c.map((r) => r.region),
          c.map((r) => r.reports),
        ],
      );
    }
    for (const r of cleaned.rejected.slice(0, REJECTED_CAP)) {
      await tx.query('INSERT INTO rejected_rows (upload_id, row_number, reason, raw) VALUES ($1, $2, $3, $4)', [
        id, r.row, r.reason, r.raw.slice(0, 1000),
      ]);
    }
  });
  return { id, filename, summary: cleaned.summary, alreadyUploaded: false };
}

// -------------------------------------------------------------------- reads

export interface DateRange {
  /** inclusive */
  from: string;
  /** exclusive */
  toExclusive: string;
}

export async function listUploads(db: Queryable) {
  const r = await db.query(
    'SELECT id, filename, uploaded_at, summary FROM uploads ORDER BY uploaded_at DESC LIMIT 50',
  );
  return r.rows;
}

export async function uploadExists(db: Queryable, id: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM uploads WHERE id = $1', [id]);
  return r.rows.length > 0;
}

function rangeClause(range: DateRange | null, params: unknown[]): string {
  if (!range) return '';
  params.push(range.from, range.toExclusive);
  return ` AND ts >= $${params.length - 1}::timestamptz AND ts < $${params.length}::timestamptz`;
}

export async function fetchStatRows(db: Queryable, uploadId: string, range: DateRange | null): Promise<StatRow[]> {
  const params: unknown[] = [uploadId];
  const sql = `SELECT service_id, service_name, ts, status_code, outcome, latency_ms
               FROM checks WHERE upload_id = $1${rangeClause(range, params)}
               ORDER BY service_id, ts`;
  const r = await db.query(sql, params);
  return r.rows.map((x) => ({
    serviceId: x.service_id,
    serviceName: x.service_name,
    tsMs: new Date(x.ts).getTime(),
    statusCode: x.status_code,
    outcome: x.outcome,
    latencyMs: x.latency_ms,
  }));
}

export interface LogQuery {
  uploadId: string;
  range: DateRange | null;
  service?: string;
  outcome?: string;
  page: number;
  pageSize: number;
}

export async function queryLogs(db: Queryable, q: LogQuery) {
  const params: unknown[] = [q.uploadId];
  let where = `upload_id = $1${rangeClause(q.range, params)}`;
  if (q.service) {
    params.push(q.service);
    where += ` AND service_id = $${params.length}`;
  }
  if (q.outcome) {
    params.push(q.outcome);
    where += ` AND outcome = $${params.length}`;
  }
  const total = Number((await db.query(`SELECT count(*)::int AS n FROM checks WHERE ${where}`, params)).rows[0].n);
  const limitParams = [...params, q.pageSize, (q.page - 1) * q.pageSize];
  const rows = await db.query(
    `SELECT service_id, service_name, ts, status_code, outcome, latency_ms, agent, region, reports
     FROM checks WHERE ${where}
     ORDER BY ts DESC, service_id
     LIMIT $${limitParams.length - 1} OFFSET $${limitParams.length}`,
    limitParams,
  );
  return {
    total,
    rows: rows.rows.map((x) => ({
      serviceId: x.service_id,
      serviceName: x.service_name,
      ts: new Date(x.ts).toISOString(),
      statusCode: x.status_code,
      outcome: x.outcome,
      latencyMs: x.latency_ms,
      agent: x.agent,
      region: x.region,
      reports: x.reports,
    })),
  };
}
