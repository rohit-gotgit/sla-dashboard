export interface CsvRecord {
  /** 1-based record number in the file; the header is record 1 */
  row: number;
  cells: string[];
}

/**
 * Minimal RFC-4180 CSV parser (quoted fields, escaped quotes, CRLF/LF, BOM).
 * Blank lines are skipped but still counted in `row` so numbers match the file.
 */
export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const out: CsvRecord[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let row = 0;

  const endRecord = () => {
    cells.push(field);
    row += 1;
    const blank = cells.length === 1 && cells[0].trim() === '';
    if (!blank) out.push({ row, cells });
    cells = [];
    field = '';
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      cells.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
    } else {
      field += c;
    }
  }
  if (field !== '' || cells.length > 0) endRecord();
  return out;
}
