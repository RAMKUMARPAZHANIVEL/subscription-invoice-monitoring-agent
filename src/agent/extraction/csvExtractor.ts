/**
 * CSV structured-data extraction (research.md #4) — parses CSV attachments (e.g. usage-based
 * billing exports) into header-keyed records before handing them to structured extraction.
 * Malformed CSV (unclosed quotes, ragged rows, duplicate headers) surfaces as `CsvExtractionError`
 * rather than partial/garbled rows, so per-email isolation can record a diagnosable `errorReason`
 * (constitution Principles I, VI) instead of silently passing broken data downstream.
 */

import { parse } from 'csv-parse/sync';

export interface CsvExtractionResult {
  headers: string[];
  rows: Record<string, string>[];
  rowCount: number;
}

export class CsvExtractionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CsvExtractionError';
  }
}

export function extractCsvData(data: Buffer): CsvExtractionResult {
  if (data.length === 0) {
    throw new CsvExtractionError('Cannot extract data from an empty CSV attachment (0 bytes)');
  }

  let records: Record<string, string>[];
  try {
    records = parse<Record<string, string>>(data, {
      columns: true,
      bom: true,
      trim: true,
      skip_empty_lines: true,
    });
  } catch (err) {
    throw new CsvExtractionError('Failed to parse CSV attachment (malformed CSV)', {
      cause: err,
    });
  }

  const [firstRow] = records;
  if (!firstRow) {
    throw new CsvExtractionError('CSV attachment contains a header row but no data rows');
  }

  return {
    headers: Object.keys(firstRow),
    rows: records,
    rowCount: records.length,
  };
}
