import { cleanCsv } from '../lib/clean';
import { getDb, saveUpload } from '../lib/db';
import { HttpError, readBody, route, send } from '../lib/http';
import { ValidationError } from '../lib/types';

/**
 * Stateless serverless function: receives the raw CSV, validates + cleans it,
 * persists the result to Postgres and returns a data-quality summary.
 * Holds no state between invocations.
 */
export default route(['POST'], async (req, res) => {
  const text = await readBody(req);
  if (!text.trim()) throw new HttpError(400, 'Request body is empty. Send the CSV as the request body.');

  const rawName = req.headers['x-filename'];
  const filename = (Array.isArray(rawName) ? rawName[0] : rawName)?.slice(0, 200) || 'upload.csv';

  let cleaned;
  try {
    cleaned = cleanCsv(text);
  } catch (e) {
    if (e instanceof ValidationError) throw new HttpError(422, e.message);
    throw e;
  }
  if (cleaned.records.length === 0) {
    throw new HttpError(422, 'No valid rows found in the file.');
  }

  const saved = await saveUpload(await getDb(), filename, text, cleaned);
  send(res, saved.alreadyUploaded ? 200 : 201, {
    uploadId: saved.id,
    filename: saved.filename,
    alreadyUploaded: saved.alreadyUploaded,
    summary: saved.summary,
  });
});
