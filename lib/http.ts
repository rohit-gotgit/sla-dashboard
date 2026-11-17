import type { IncomingMessage, ServerResponse } from 'node:http';
import { DateRange } from './db';

export const MAX_BODY_BYTES = 4 * 1024 * 1024; // Vercel's request limit is 4.5 MB

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/** Wraps a handler so thrown HttpErrors become clean JSON errors and nothing leaks stack traces. */
export function route(
  methods: string[],
  fn: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>,
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (!methods.includes(req.method ?? '')) {
        res.setHeader('Allow', methods.join(', '));
        throw new HttpError(405, `Method ${req.method} not allowed`);
      }
      await fn(req, res, new URL(req.url ?? '/', 'http://localhost'));
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      send(res, 500, { error: 'Internal server error' });
    }
  };
}

/** Reads the request body regardless of whether the platform pre-parsed it. */
export async function readBody(req: IncomingMessage): Promise<string> {
  const pre = (req as any).body;
  if (typeof pre === 'string') return checkSize(pre);
  if (Buffer.isBuffer(pre)) return checkSize(pre.toString('utf8'));

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'File too large (max 4 MB)');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function checkSize(s: string) {
  if (Buffer.byteLength(s) > MAX_BODY_BYTES) throw new HttpError(413, 'File too large (max 4 MB)');
  return s;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUploadId(url: URL): string {
  const id = url.searchParams.get('upload') ?? '';
  if (!UUID_RE.test(id)) throw new HttpError(400, 'Missing or invalid "upload" id');
  return id;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
function parseDay(label: string, v: string): number {
  if (!DAY_RE.test(v)) throw new HttpError(400, `"${label}" must be YYYY-MM-DD`);
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== v) {
    throw new HttpError(400, `"${label}" is not a real calendar date`);
  }
  return ms;
}

/**
 * ?date=YYYY-MM-DD            -> that single UTC day
 * ?from=YYYY-MM-DD&to=...     -> inclusive UTC day range (either end may be omitted)
 */
export function parseRange(url: URL): DateRange | null {
  const date = url.searchParams.get('date');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  if (date && (from || to)) throw new HttpError(400, 'Use either "date" or "from"/"to", not both');
  const DAY = 86_400_000;
  if (date) {
    const ms = parseDay('date', date);
    return { from: new Date(ms).toISOString(), toExclusive: new Date(ms + DAY).toISOString() };
  }
  if (!from && !to) return null;
  const fromMs = from ? parseDay('from', from) : Date.parse('1970-01-01T00:00:00Z');
  const toMs = to ? parseDay('to', to) : Date.parse('9999-12-30T00:00:00Z');
  if (fromMs > toMs) throw new HttpError(400, '"from" must not be after "to"');
  return { from: new Date(fromMs).toISOString(), toExclusive: new Date(toMs + DAY).toISOString() };
}
