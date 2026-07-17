import { describe, expect, it } from 'vitest';
import { extractCsvData, CsvExtractionError } from './csvExtractor.js';

describe('extractCsvData', () => {
  it('parses headers and rows from well-formed CSV', () => {
    const csv = 'vendor,amount,currency\nAcme Cloud,42.50,USD\nAcme Cloud,10.00,USD\n';

    const result = extractCsvData(Buffer.from(csv, 'utf-8'));

    expect(result.headers).toEqual(['vendor', 'amount', 'currency']);
    expect(result.rowCount).toBe(2);
    expect(result.rows).toEqual([
      { vendor: 'Acme Cloud', amount: '42.50', currency: 'USD' },
      { vendor: 'Acme Cloud', amount: '10.00', currency: 'USD' },
    ]);
  });

  it('supports quoted values, including embedded commas and escaped quotes', () => {
    const csv = 'description,amount\n"Consulting, Q1 review",100.00\n"He said ""hello""",5.00\n';

    const result = extractCsvData(Buffer.from(csv, 'utf-8'));

    expect(result.rows).toEqual([
      { description: 'Consulting, Q1 review', amount: '100.00' },
      { description: 'He said "hello"', amount: '5.00' },
    ]);
  });

  it('handles UTF-8 content, including a byte-order mark and non-ASCII characters', () => {
    const csv = '﻿vendor,amount\nÉcole Café,€12.34\n';

    const result = extractCsvData(Buffer.from(csv, 'utf-8'));

    expect(result.headers).toEqual(['vendor', 'amount']);
    expect(result.rows).toEqual([{ vendor: 'École Café', amount: '€12.34' }]);
  });

  it('throws CsvExtractionError for malformed CSV with an unclosed quote', () => {
    const csv = 'vendor,amount\n"Unterminated,42.00\n';

    expect(() => extractCsvData(Buffer.from(csv, 'utf-8'))).toThrow(CsvExtractionError);
  });

  it('throws CsvExtractionError for malformed CSV with an inconsistent column count', () => {
    const csv = 'vendor,amount,currency\nAcme Cloud,42.50\n';

    expect(() => extractCsvData(Buffer.from(csv, 'utf-8'))).toThrow(CsvExtractionError);
  });

  it('throws CsvExtractionError for a zero-byte (empty) CSV buffer', () => {
    expect(() => extractCsvData(Buffer.alloc(0))).toThrow(CsvExtractionError);
    expect(() => extractCsvData(Buffer.alloc(0))).toThrow(/empty/i);
  });

  it('throws CsvExtractionError for a header-only CSV with no data rows', () => {
    const csv = 'vendor,amount,currency\n';

    expect(() => extractCsvData(Buffer.from(csv, 'utf-8'))).toThrow(CsvExtractionError);
    expect(() => extractCsvData(Buffer.from(csv, 'utf-8'))).toThrow(/no data rows/i);
  });
});
