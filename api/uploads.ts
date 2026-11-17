import { getDb, listUploads } from '../lib/db';
import { route, send } from '../lib/http';

export default route(['GET'], async (_req, res) => {
  const rows = await listUploads(await getDb());
  send(res, 200, {
    uploads: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      uploadedAt: new Date(r.uploaded_at).toISOString(),
      summary: r.summary,
    })),
  });
});
