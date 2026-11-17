import { fetchStatRows, getDb, uploadExists } from '../lib/db';
import { HttpError, parseRange, requireUploadId, route, send } from '../lib/http';
import { computeStats } from '../lib/stats';

export default route(['GET'], async (_req, res, url) => {
  const uploadId = requireUploadId(url);
  const range = parseRange(url);
  const db = await getDb();
  if (!(await uploadExists(db, uploadId))) throw new HttpError(404, 'Upload not found');
  send(res, 200, computeStats(await fetchStatRows(db, uploadId, range)));
});
