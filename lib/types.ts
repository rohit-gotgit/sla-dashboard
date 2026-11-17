export type Outcome = 'up' | 'down' | 'unknown';

/** One cleaned, de-duplicated health check (one service, one 15-minute slot). */
export interface CheckRecord {
  serviceId: string;
  serviceName: string;
  /** ISO-8601 UTC string */
  ts: string;
  tsMs: number;
  /** null when the reported status was not a valid HTTP code */
  statusCode: number | null;
  /** up = 1xx-4xx, down = 5xx, unknown = invalid status code */
  outcome: Outcome;
  /** always milliseconds; null when missing/invalid */
  latencyMs: number | null;
  agent: string;
  region: string;
  /** how many raw rows were merged into this record (>=1) */
  reports: number;
}

export interface RejectedRow {
  row: number;
  reason: string;
  raw: string;
}

export interface CleaningSummary {
  rowsReceived: number;
  rowsRejected: number;
  rejectedByReason: Record<string, number>;
  /** unique (service, slot) checks stored */
  checksStored: number;
  /** raw rows folded into another row for the same service+timestamp */
  duplicateRowsMerged: number;
  /** duplicate groups whose valid rows disagreed on up/down (resolved to "down") */
  conflictingDuplicateGroups: number;
  timestampFormats: Record<string, number>;
  timestampsNormalizedToUtc: number;
  latencyConvertedFromSeconds: number;
  latencyMissing: number;
  latencyInvalid: number;
  unknownLatencyUnit: number;
  invalidStatusRows: number;
  offGridTimestamps: number;
  services: string[];
  range: { from: string; to: string } | null;
  expectedChecksPerService: number;
  missingSlotsByService: Record<string, number>;
}

export interface CleanResult {
  records: CheckRecord[];
  rejected: RejectedRow[];
  summary: CleaningSummary;
}

export class ValidationError extends Error {}
