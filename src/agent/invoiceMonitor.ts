import { logger } from '../lib/logger.js';

export interface InvoiceCheckResult {
  checkedAt: string;
  anomalies: string[];
}

/**
 * Entry point for a single subscription invoice monitoring pass.
 * Fetching/parsing invoices and anomaly detection land here as the agent grows.
 */
export function runInvoiceCheck(): Promise<InvoiceCheckResult> {
  logger.info('Running subscription invoice check');

  return Promise.resolve({
    checkedAt: new Date().toISOString(),
    anomalies: [],
  });
}
