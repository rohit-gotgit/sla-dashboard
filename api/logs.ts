import { getDb, queryLogs, uploadExists } from '../lib/db';
import { HttpError, parseRange, requireUploadId, route, send } from '../lib/http';

const OUTCOMES = ['up', 'down', 'unknown'];

function intParam(url: URL, name: string, def: number, min: number, max: number) {
  const raw = url.searchParams.get(name);
  if (raw === null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `"${name}" must be an integer between ${min} and ${max}`);
  }
  return n;
}

export default route(['GET'], async (_req, res, url) => {
  const uploadId = requireUploadId(url);
  const range = parseRange(url);
  const service = url.searchParams.get('service') || undefined;
  const outcome = url.searchParams.get('outcome') || undefined;
  if (outcome && !OUTCOMES.includes(outcome)) throw new HttpError(400, `"outcome" must be one of ${OUTCOMES.join(', ')}`);
  const page = intParam(url, 'page', 1, 1, 100000);
  const pageSize = intParam(url, 'pageSize', 50, 1, 200);

  const db = await getDb();
  if (!(await uploadExists(db, uploadId))) throw new HttpError(404, 'Upload not found');
  const { total, rows } = await queryLogs(db, { uploadId, range, service, outcome, page, pageSize });
  send(res, 200, { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)), rows });
});
