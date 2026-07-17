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

const invoiceFindMany = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const invoiceFindUnique = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock('./storage/prisma.js', () => ({
  prisma: {
    invoice: {
      findMany: (...args: unknown[]) => invoiceFindMany(...args),
      findUnique: (...args: unknown[]) => invoiceFindUnique(...args),
    },
  },
}));

const { createServer } = await import('./server.js');
const { Prisma } = await import('./generated/prisma/client.js');

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

function buildInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv_abc123',
    sourceEmailId: 'se_1',
    vendorId: 'vendor_1',
    amount: new Prisma.Decimal('49.00'),
    currency: 'USD',
    invoiceDate: new Date('2026-07-01T00:00:00.000Z'),
    billingPeriodStart: new Date('2026-06-01T00:00:00.000Z'),
    billingPeriodEnd: new Date('2026-06-30T00:00:00.000Z'),
    subscriptionType: 'PER_SEAT',
    lineItems: null,
    extractionConfidence: 'HIGH',
    createdAt: new Date('2026-07-01T08:00:00.000Z'),
    updatedAt: new Date('2026-07-01T08:00:00.000Z'),
    vendor: { name: 'GitHub' },
    attachments: [{ id: 'att_1' }],
    ...overrides,
  };
}

describe('GET /invoices', () => {
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createServer>['listen']>;

  beforeEach(() => {
    invoiceFindMany.mockReset();
    const app = createServer();
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.close();
  });

  it('returns the mapped invoice list with no next cursor when the page is not full', async () => {
    invoiceFindMany.mockResolvedValue([buildInvoiceRow()]);

    const response = await fetch(`${baseUrl}/invoices`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      invoices: [
        {
          id: 'inv_abc123',
          vendor: 'GitHub',
          amount: '49.00',
          currency: 'USD',
          invoiceDate: '2026-07-01',
          billingPeriodStart: '2026-06-01',
          billingPeriodEnd: '2026-06-30',
          subscriptionType: 'PER_SEAT',
          extractionConfidence: 'HIGH',
          attachmentCount: 1,
        },
      ],
      nextCursor: null,
    });
  });

  it('requests one extra row and returns a nextCursor when more results exist', async () => {
    invoiceFindMany.mockResolvedValue([
      buildInvoiceRow({ id: 'inv_1' }),
      buildInvoiceRow({ id: 'inv_2' }),
    ]);

    const response = await fetch(`${baseUrl}/invoices?limit=1`);
    const body = (await response.json()) as { invoices: unknown[]; nextCursor: string | null };

    expect(response.status).toBe(200);
    expect(body.invoices).toHaveLength(1);
    expect(body.nextCursor).toBe('inv_1');
    expect(invoiceFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 2, where: {} }));
  });

  it('filters by vendor, subscriptionType, and invoice date range', async () => {
    invoiceFindMany.mockResolvedValue([]);

    const response = await fetch(
      `${baseUrl}/invoices?vendor=GitHub&subscriptionType=PER_SEAT&from=2026-01-01&to=2026-12-31`,
    );

    expect(response.status).toBe(200);
    expect(invoiceFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          vendor: { name: 'GitHub' },
          subscriptionType: 'PER_SEAT',
          invoiceDate: { gte: new Date('2026-01-01'), lte: new Date('2026-12-31') },
        },
      }),
    );
  });

  it('returns 400 for an invalid subscriptionType filter', async () => {
    const response = await fetch(`${baseUrl}/invoices?subscriptionType=NOT_REAL`);

    expect(response.status).toBe(400);
    expect(invoiceFindMany).not.toHaveBeenCalled();
  });

  it('returns 500 when the query fails', async () => {
    invoiceFindMany.mockRejectedValue(new Error('DB unavailable'));

    const response = await fetch(`${baseUrl}/invoices`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error' });
  });
});

describe('GET /invoices/:id', () => {
  let baseUrl: string;
  let server: ReturnType<ReturnType<typeof createServer>['listen']>;

  beforeEach(() => {
    invoiceFindUnique.mockReset();
    const app = createServer();
    server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(() => {
    server.close();
  });

  it('returns the full invoice detail including related entities', async () => {
    invoiceFindUnique.mockResolvedValue(
      buildInvoiceRow({
        lineItems: [{ description: '5 seats', amount: '49.00' }],
        sourceEmail: {
          gmailMessageId: '18f2a',
          sender: 'billing@github.com',
          subject: 'Your GitHub receipt',
          receivedAt: new Date('2026-07-01T08:00:00.000Z'),
        },
        attachments: [{ id: 'att_1', filename: 'receipt.pdf', mimeType: 'application/pdf' }],
        processingHistoryEntries: [
          {
            outcome: 'PROCESSED',
            attemptNumber: 1,
            evaluatedAt: new Date('2026-07-10T06:00:12.000Z'),
          },
        ],
      }),
    );

    const response = await fetch(`${baseUrl}/invoices/inv_abc123`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'inv_abc123',
      vendor: 'GitHub',
      amount: '49.00',
      currency: 'USD',
      invoiceDate: '2026-07-01',
      billingPeriodStart: '2026-06-01',
      billingPeriodEnd: '2026-06-30',
      subscriptionType: 'PER_SEAT',
      lineItems: [{ description: '5 seats', amount: '49.00' }],
      extractionConfidence: 'HIGH',
      sourceEmail: {
        gmailMessageId: '18f2a',
        sender: 'billing@github.com',
        subject: 'Your GitHub receipt',
        receivedAt: '2026-07-01T08:00:00.000Z',
      },
      attachments: [{ id: 'att_1', filename: 'receipt.pdf', mimeType: 'application/pdf' }],
      processingHistory: [
        { outcome: 'PROCESSED', attemptNumber: 1, evaluatedAt: '2026-07-10T06:00:12.000Z' },
      ],
    });
    expect(invoiceFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'inv_abc123' } }),
    );
  });

  it('returns 404 when the invoice does not exist', async () => {
    invoiceFindUnique.mockResolvedValue(null);

    const response = await fetch(`${baseUrl}/invoices/does-not-exist`);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: 'error', message: 'Invoice not found' });
  });

  it('returns 500 when the query fails', async () => {
    invoiceFindUnique.mockRejectedValue(new Error('DB unavailable'));

    const response = await fetch(`${baseUrl}/invoices/inv_abc123`);

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'error' });
  });
});
