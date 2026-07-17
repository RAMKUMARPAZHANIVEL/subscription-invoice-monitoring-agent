import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    PORT: 0,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    ANTHROPIC_API_KEY: 'test-anthropic-key',
    GMAIL_CLIENT_ID: 'test-client-id',
    GMAIL_CLIENT_SECRET: 'test-client-secret',
    GMAIL_REFRESH_TOKEN: 'test-refresh-token',
    GMAIL_ADMIN_EMAIL: 'admin@example.com',
    GCS_BUCKET_NAME: 'test-bucket',
    ATTACHMENT_STORE_DRIVER: 'local',
    ATTACHMENT_STORE_LOCAL_DIR: '.data/attachments-test',
  },
}));

const runInvoiceCheck = vi.fn<() => Promise<unknown>>();
vi.mock('./agent/invoiceMonitor.js', () => ({
  runInvoiceCheck: () => runInvoiceCheck(),
}));

const { createServer } = await import('./server.js');

describe('POST /tasks/ingest-invoices', () => {
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createServer>['listen']>;

  beforeEach(() => {
    runInvoiceCheck.mockReset();
    const app = createServer();
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.close();
  });

  it('invokes the orchestrator and returns the run summary', async () => {
    runInvoiceCheck.mockResolvedValue({
      runId: 'run_1',
      startedAt: '2026-07-10T06:00:00.000Z',
      finishedAt: '2026-07-10T06:01:42.000Z',
      durationMs: 102000,
      emailsScanned: 14,
      invoiceEmailsFound: 12,
      invoicesProcessed: 11,
      skipped: 1,
      failures: 1,
    });

    const response = await fetch(`${baseUrl}/tasks/ingest-invoices`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      startedAt: '2026-07-10T06:00:00.000Z',
      finishedAt: '2026-07-10T06:01:42.000Z',
      durationMs: 102000,
      emailsScanned: 14,
      invoicesProcessed: 11,
      failures: 1,
    });
    expect(runInvoiceCheck).toHaveBeenCalledTimes(1);
  });

  it('returns 500 when the run fails before completion', async () => {
    runInvoiceCheck.mockRejectedValue(new Error('Gmail auth failure'));

    const response = await fetch(`${baseUrl}/tasks/ingest-invoices`, { method: 'POST' });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error' });
  });
});
