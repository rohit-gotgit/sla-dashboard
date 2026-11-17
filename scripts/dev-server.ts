/**
 * Local development server: serves ./public and mounts ./api/*.ts exactly like Vercel does.
 * Uses DATABASE_URL if set, otherwise an embedded Postgres (PGlite) persisted in ./.data
 */
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { setDb } from '../lib/db';

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = join(__dirname, '..', 'public');
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function main() {
  if (!process.env.DATABASE_URL) {
    const { PGlite } = await import('@electric-sql/pglite');
    const { pgliteDb } = await import('../lib/pglite-adapter');
    const dataDir = join(__dirname, '..', '.data');
    mkdirSync(dataDir, { recursive: true }); // PGlite needs the parent folder to exist
    setDb(pgliteDb(new PGlite(join(dataDir, 'pglite'))));
    console.log('DATABASE_URL not set -> using embedded Postgres in .data/pglite');
  }
  const handlers: Record<string, (req: any, res: any) => Promise<void>> = {
    upload: (await import('../api/upload')).default,
    uploads: (await import('../api/uploads')).default,
    stats: (await import('../api/stats')).default,
    logs: (await import('../api/logs')).default,
  };

  createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      const h = handlers[url.pathname.slice(5)];
      if (!h) {
        res.statusCode = 404;
        return res.end(JSON.stringify({ error: 'Not found' }));
      }
      return h(req, res);
    }
    const rel = normalize(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^(\.\.[/\\])+/, '');
    try {
      const body = await readFile(join(PUBLIC_DIR, rel));
      res.setHeader('Content-Type', TYPES[extname(rel)] ?? 'application/octet-stream');
      res.end(body);
    } catch {
      res.statusCode = 404;
      res.end('Not found');
    }
  }).listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
main();
