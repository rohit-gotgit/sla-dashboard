import { describe, expect, it } from 'vitest';
import { cleanCsv, parseLatency, parseStatus, parseTimestamp } from '../lib/clean';
import { parseCsv } from '../lib/csv';
import { ValidationError } from '../lib/types';

const HEADER = 'service_id,service_name,timestamp,status_code,latency,latency_unit,agent,region';
const row = (...c: string[]) => c.join(',');

describe('parseTimestamp', () => {
  it('parses ISO UTC', () => {
    expect(parseTimestamp('2025-05-13T12:45:00Z')).toEqual({ ms: Date.UTC(2025, 4, 13, 12, 45), format: 'iso_utc' });
  });
  it('converts +05:30 offsets to UTC', () => {
    const r = parseTimestamp('2025-05-26T11:15:00+05:30')!;
    expect(new Date(r.ms).toISOString()).toBe('2025-05-26T05:45:00.000Z');
    expect(r.format).toBe('iso_offset');
  });
  it('handles negative offsets crossing midnight', () => {
    expect(new Date(parseTimestamp('2025-05-26T23:00:00-02:00')!.ms).toISOString()).toBe('2025-05-27T01:00:00.000Z');
  });
  it('parses epoch seconds and milliseconds', () => {
    expect(new Date(parseTimestamp('1746938700')!.ms).toISOString()).toBe('2025-05-11T04:45:00.000Z');
    expect(parseTimestamp('1746938700000')!.ms).toBe(1746938700000);
  });
  it('rejects garbage and impossible dates', () => {
    expect(parseTimestamp('yesterday')).toBeNull();
    expect(parseTimestamp('2025-02-30T10:00:00Z')).toBeNull();
    expect(parseTimestamp('2025-05-13T25:00:00Z')).toBeNull();
    expect(parseTimestamp('')).toBeNull();
  });
});

describe('parseLatency', () => {
  it('keeps ms, converts seconds, removes float noise', () => {
    expect(parseLatency('707', 'ms')).toEqual({ kind: 'ok', ms: 707, converted: false });
    expect(parseLatency('0.717', 's')).toEqual({ kind: 'ok', ms: 717, converted: true });
  });
  it('flags missing, negative, non-numeric and unknown units', () => {
    expect(parseLatency('', 'ms').kind).toBe('missing');
    expect(parseLatency('-286', 'ms').kind).toBe('invalid');
    expect(parseLatency('abc', 'ms').kind).toBe('invalid');
    expect(parseLatency('5', 'furlongs').kind).toBe('unknown_unit');
  });
});

describe('parseStatus', () => {
  it('classifies outcomes', () => {
    expect(parseStatus('200').outcome).toBe('up');
    expect(parseStatus('404').outcome).toBe('up');
    expect(parseStatus('503').outcome).toBe('down');
    expect(parseStatus('999').outcome).toBe('unknown');
    expect(parseStatus('').outcome).toBe('unknown');
  });
});

describe('parseCsv', () => {
  it('handles quotes, CRLF, BOM and blank lines', () => {
    const recs = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n\r\nz,\r\n');
    expect(recs.map((r) => r.cells)).toEqual([['a', 'b'], ['x,1', 'he said "hi"'], ['z', '']]);
    expect(recs[2].row).toBe(4); // blank line still counted
  });
});

describe('cleanCsv', () => {
  it('rejects files with missing columns', () => {
    expect(() => cleanCsv('service_id,timestamp\nx,y')).toThrow(ValidationError);
    expect(() => cleanCsv('')).toThrow(ValidationError);
  });

  it('merges agent duplicates: prefers valid status, then latency, then lowest agent', () => {
    const csv = [
      HEADER,
      row('svc-a', 'a-api', '2025-05-01T00:00:00Z', '999', '100', 'ms', 'agent-1', 'r'),
      row('svc-a', 'a-api', '2025-05-01T00:00:00Z', '200', '', 'ms', 'agent-2', 'r'),
      row('svc-a', 'a-api', '1746057600', '200', '90', 'ms', 'agent-1', 'r'), // same instant as above, epoch form
    ].join('\n');
    const { records, summary } = cleanCsv(csv);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ outcome: 'up', statusCode: 200, latencyMs: 90, agent: 'agent-1', reports: 3 });
    expect(summary.duplicateRowsMerged).toBe(2);
    expect(summary.invalidStatusRows).toBe(1);
  });

  it('does not hide an outage when two valid agents disagree', () => {
    const csv = [
      HEADER,
      row('svc-a', 'a-api', '2025-05-01T00:00:00Z', '200', '10', 'ms', 'agent-1', 'r'),
      row('svc-a', 'a-api', '2025-05-01T00:00:00Z', '503', '12', 'ms', 'agent-2', 'r'),
    ].join('\n');
    const { records, summary } = cleanCsv(csv);
    expect(records[0].outcome).toBe('down');
    expect(summary.conflictingDuplicateGroups).toBe(1);
  });

  it('rejects unusable rows but keeps the rest, with reasons', () => {
    const csv = [
      HEADER,
      row('svc-a', 'a-api', 'not-a-date', '200', '10', 'ms', 'agent-1', 'r'),
      row('', 'a-api', '2025-05-01T00:00:00Z', '200', '10', 'ms', 'agent-1', 'r'),
      row('svc-a', 'a-api', '2025-05-01T00:00:00Z', '200'),
      row('svc-a', 'a-api', '2025-05-01T00:15:00Z', '200', '10', 'ms', 'agent-1', 'r'),
    ].join('\n');
    const { records, rejected, summary } = cleanCsv(csv);
    expect(records).toHaveLength(1);
    expect(rejected.map((r) => r.reason).sort()).toEqual(['column_count_mismatch', 'invalid_timestamp', 'missing_service_id']);
    expect(summary.rowsRejected).toBe(3);
  });

  it('detects missing slots', () => {
    const csv = [
      HEADER,
      row('svc-a', 'a', '2025-05-01T00:00:00Z', '200', '1', 'ms', 'agent-1', 'r'),
      row('svc-a', 'a', '2025-05-01T00:45:00Z', '200', '1', 'ms', 'agent-1', 'r'),
    ].join('\n');
    const { summary } = cleanCsv(csv);
    expect(summary.expectedChecksPerService).toBe(4);
    expect(summary.missingSlotsByService['svc-a']).toBe(2);
  });
});
