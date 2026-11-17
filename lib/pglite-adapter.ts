import type { PGlite } from '@electric-sql/pglite';
import type { Db } from './db';

/** Wraps an embedded PGlite instance in the same interface as the production `pg` pool. */
export function pgliteDb(pg: PGlite): Db {
  return {
    query: (text, params) => pg.query(text, params as any[]) as Promise<{ rows: any[] }>,
    transaction: (fn) =>
      pg.transaction((tx) => fn({ query: (t, p) => tx.query(t, p as any[]) as Promise<{ rows: any[] }> })),
  };
}
