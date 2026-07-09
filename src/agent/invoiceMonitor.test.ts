import { describe, expect, it } from 'vitest';
import { runInvoiceCheck } from './invoiceMonitor.js';

describe('runInvoiceCheck', () => {
  it('returns a result with a timestamp and no anomalies by default', async () => {
    const result = await runInvoiceCheck();

    expect(result.anomalies).toEqual([]);
    expect(new Date(result.checkedAt).toString()).not.toBe('Invalid Date');
  });
});
