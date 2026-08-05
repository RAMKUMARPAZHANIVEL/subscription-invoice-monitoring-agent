import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as AiExtractorModule from './extraction/aiExtractor.js';

// invoiceMonitor.ts transitively imports env.ts (via the Gmail client, Prisma, and the
// attachment stores); mock it so this file's pure-function tests don't require a full
// Gmail/DB/GCS environment to be configured, matching gmail/attachments.test.ts's pattern.
// DATABASE_URL points at the real local test database (see README.md) so the duplicate-prevention
// integration test below can exercise actual Prisma upsert/unique-constraint behavior — the
// constitution (Principle X / CLAUDE.md Testing) prohibits mocking the database.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL:
      'postgresql://app_user:your_password@localhost:5433/subscription_invoice_dev?schema=public',
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

const extractInvoiceDataMock = vi.fn();
vi.mock('./extraction/aiExtractor.js', async (importOriginal) => ({
  // invoiceMonitor.ts's isRecoverableError does `err instanceof AiExtractionError`, so the real
  // class must survive the mock even though extractInvoiceData itself is stubbed.
  ...(await importOriginal<typeof AiExtractorModule>()),
  extractInvoiceData: extractInvoiceDataMock,
}));

const { LocalAttachmentStore } = await import('../storage/localAttachmentStore.js');
const { prisma } = await import('../storage/prisma.js');
const { buildSourceText, classifyAttachmentType, extractBodyText, getHeader, runInvoiceCheck } =
  await import('./invoiceMonitor.js');
const { AiExtractionError } = await import('./extraction/aiExtractor.js');
import type { GmailClient, GmailMessagePart } from './gmail/client.js';

describe('getHeader', () => {
  it('finds a header case-insensitively', () => {
    const payload: GmailMessagePart = {
      headers: [{ name: 'Subject', value: 'Your invoice' }],
    };

    expect(getHeader(payload, 'subject')).toBe('Your invoice');
  });

  it('returns undefined when the header is absent', () => {
    expect(getHeader({ headers: [] }, 'From')).toBeUndefined();
    expect(getHeader(undefined, 'From')).toBeUndefined();
  });
});

describe('extractBodyText', () => {
  function toBase64Url(text: string): string {
    return Buffer.from(text).toString('base64url');
  }

  it('prefers text/plain over text/html', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/html', body: { data: toBase64Url('<p>Hi</p>') } },
        { mimeType: 'text/plain', body: { data: toBase64Url('Plain body text') } },
      ],
    };

    expect(extractBodyText(payload)).toBe('Plain body text');
  });

  it('falls back to text/html with tags stripped when no plain part exists', () => {
    const payload: GmailMessagePart = {
      mimeType: 'text/html',
      body: { data: toBase64Url('<p>Amount due: <b>$49.00</b></p>') },
    };

    expect(extractBodyText(payload)).toBe('Amount due: $49.00');
  });

  it('returns undefined when there is no usable body content', () => {
    expect(extractBodyText(undefined)).toBeUndefined();
    expect(
      extractBodyText({ mimeType: 'application/pdf', filename: 'invoice.pdf' }),
    ).toBeUndefined();
  });
});

describe('classifyAttachmentType', () => {
  it('classifies by mimeType', () => {
    expect(classifyAttachmentType({ mimeType: 'application/pdf', filename: 'file' })).toBe('pdf');
    expect(classifyAttachmentType({ mimeType: 'text/csv', filename: 'file' })).toBe('csv');
  });

  it('falls back to file extension when mimeType is generic', () => {
    expect(
      classifyAttachmentType({ mimeType: 'application/octet-stream', filename: 'invoice.pdf' }),
    ).toBe('pdf');
    expect(
      classifyAttachmentType({ mimeType: 'application/vnd.ms-excel', filename: 'usage.csv' }),
    ).toBe('csv');
  });

  it('returns undefined for unsupported types', () => {
    expect(classifyAttachmentType({ mimeType: 'image/png', filename: 'logo.png' })).toBeUndefined();
  });
});

describe('buildSourceText', () => {
  let baseDir: string;
  let store: InstanceType<typeof LocalAttachmentStore>;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'sima-invoicemonitor-test-'));
    store = new LocalAttachmentStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('extracts text from a supported CSV attachment over the email body', async () => {
    const metadata = await store.save({
      filename: 'usage.csv',
      mimeType: 'text/csv',
      data: Buffer.from('description,amount\nSeats,49.00\n'),
    });

    const text = await buildSourceText(store, [metadata], 'ignored body text');

    expect(text).toContain('description,amount');
    expect(text).toContain('Seats,49.00');
  });

  it('falls back to the email body when there is no supported attachment', async () => {
    const text = await buildSourceText(store, [], 'Your invoice total is $49.00');

    expect(text).toBe('Your invoice total is $49.00');
  });

  it('throws when there is neither a supported attachment nor body text', async () => {
    await expect(buildSourceText(store, [], undefined)).rejects.toThrow(/No extractable content/);
  });

  it('throws when the only attachment is an unsupported type and there is no body text', async () => {
    const metadata = await store.save({
      filename: 'logo.png',
      mimeType: 'image/png',
      data: Buffer.from('not really a png'),
    });

    await expect(buildSourceText(store, [metadata], undefined)).rejects.toThrow(
      /No extractable content/,
    );
  });
});

describe('runInvoiceCheck duplicate prevention (integration, real Postgres)', () => {
  let vendorId: string;
  let baseDir: string;
  let attachmentStore: InstanceType<typeof LocalAttachmentStore>;

  const VALID_EXTRACTION = {
    amount: '49.00',
    currency: 'USD',
    invoiceDate: '2026-06-01',
    extractionConfidence: 'HIGH' as const,
  };

  const ATTACHMENT_CSV = 'description,amount\nSeats,49.00\n';

  function fakeGmailClient(
    gmailMessageId: string,
  ): Pick<GmailClient, 'listMessages' | 'getMessage' | 'getAttachment'> {
    return {
      listMessages: vi
        .fn()
        .mockResolvedValue({ messages: [{ id: gmailMessageId, threadId: 'thread-1' }] }),
      getMessage: vi.fn().mockResolvedValue({
        id: gmailMessageId,
        threadId: 'thread-1',
        internalDate: String(Date.now()),
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'billing@testvendor.example' },
            { name: 'Subject', value: 'Your invoice' },
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Amount due: $49.00').toString('base64url') },
            },
            {
              filename: 'invoice.csv',
              mimeType: 'text/csv',
              body: { attachmentId: 'att-1' },
            },
          ],
        },
      }),
      getAttachment: vi.fn().mockResolvedValue({
        size: Buffer.byteLength(ATTACHMENT_CSV),
        data: Buffer.from(ATTACHMENT_CSV).toString('base64url'),
      }),
    };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'sima-invoicemonitor-dup-test-'));
    attachmentStore = new LocalAttachmentStore(baseDir);
    extractInvoiceDataMock.mockReset().mockResolvedValue(VALID_EXTRACTION);

    const vendor = await prisma.vendor.create({
      data: {
        name: `Test Vendor ${randomUUID()}`,
        senderPatterns: ['billing@testvendor.example'],
        subjectPatterns: [],
      },
    });
    vendorId = vendor.id;
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await prisma.processingHistoryEntry.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.attachment.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.invoice.deleteMany({ where: { vendorId } });
    await prisma.sourceEmail.deleteMany({ where: { vendorId } });
    await prisma.vendor.delete({ where: { id: vendorId } });
  });

  it('re-running ingestion against an already-processed email creates zero duplicate invoices and records SKIPPED_DUPLICATE', async () => {
    const gmailMessageId = `msg-${randomUUID()}`;
    const gmailClient = fakeGmailClient(gmailMessageId);

    const first = await runInvoiceCheck({ gmailClient, attachmentStore });
    const second = await runInvoiceCheck({ gmailClient, attachmentStore });

    expect(first.invoicesProcessed).toBe(1);
    expect(second.invoicesProcessed).toBe(0);
    expect(second.skipped).toBe(1);

    const invoices = await prisma.invoice.findMany({ where: { vendorId } });
    expect(invoices).toHaveLength(1);

    const sourceEmails = await prisma.sourceEmail.findMany({ where: { gmailMessageId } });
    expect(sourceEmails).toHaveLength(1);

    const attachments = await prisma.attachment.findMany({
      where: { sourceEmailId: sourceEmails[0]!.id },
    });
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.filename).toBe('invoice.csv');
    expect(attachments[0]?.invoiceId).toBe(invoices[0]!.id);

    const history = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmails[0]!.id },
      orderBy: { attemptNumber: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[0]?.outcome).toBe('PROCESSED');
    expect(history[1]?.outcome).toBe('SKIPPED_DUPLICATE');
    expect(history[1]?.invoiceId).toBe(invoices[0]!.id);
  });
});

describe('runInvoiceCheck per-email isolation (integration, real Postgres)', () => {
  let vendorId: string;
  let baseDir: string;
  let attachmentStore: InstanceType<typeof LocalAttachmentStore>;

  const VALID_EXTRACTION = {
    amount: '49.00',
    currency: 'USD',
    invoiceDate: '2026-06-01',
    extractionConfidence: 'HIGH' as const,
  };

  const ATTACHMENT_CSV = 'description,amount\nSeats,49.00\n';

  interface FixtureEmail {
    gmailMessageId: string;
    subject: string;
    attachmentId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }

  // T034 (US3): email B carries a zero-byte "PDF" attachment, which extractPdfText (per
  // pdfExtractor.test.ts) rejects as unparseable rather than silently producing empty text — a
  // deterministic stand-in for "malformed attachment" that doesn't depend on the mocked Claude
  // call and fails on the first attempt (not a recoverable error, so no retries/backoff).
  function fakeGmailClientForBatch(
    emails: FixtureEmail[],
  ): Pick<GmailClient, 'listMessages' | 'getMessage' | 'getAttachment'> {
    return {
      listMessages: vi.fn().mockResolvedValue({
        messages: emails.map((email) => ({ id: email.gmailMessageId, threadId: 'thread-1' })),
      }),
      getMessage: vi.fn().mockImplementation((messageId: string) => {
        const email = emails.find((candidate) => candidate.gmailMessageId === messageId);
        if (!email) throw new Error(`Unexpected messageId: ${messageId}`);
        return {
          id: email.gmailMessageId,
          threadId: 'thread-1',
          internalDate: String(Date.now()),
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: 'billing@testvendor.example' },
              { name: 'Subject', value: email.subject },
            ],
            parts: [
              {
                filename: email.filename,
                mimeType: email.mimeType,
                body: { attachmentId: email.attachmentId },
              },
            ],
          },
        };
      }),
      getAttachment: vi.fn().mockImplementation((_messageId: string, attachmentId: string) => {
        const email = emails.find((candidate) => candidate.attachmentId === attachmentId);
        if (!email) throw new Error(`Unexpected attachmentId: ${attachmentId}`);
        return {
          size: email.data.length,
          data: email.data.toString('base64url'),
        };
      }),
    };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'sima-invoicemonitor-isolation-test-'));
    attachmentStore = new LocalAttachmentStore(baseDir);
    extractInvoiceDataMock.mockReset().mockResolvedValue(VALID_EXTRACTION);

    const vendor = await prisma.vendor.create({
      data: {
        name: `Test Vendor ${randomUUID()}`,
        senderPatterns: ['billing@testvendor.example'],
        subjectPatterns: [],
      },
    });
    vendorId = vendor.id;
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await prisma.processingHistoryEntry.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.attachment.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.invoice.deleteMany({ where: { vendorId } });
    await prisma.sourceEmail.deleteMany({ where: { vendorId } });
    await prisma.vendor.delete({ where: { id: vendorId } });
  });

  it('does not let one failing email abort the rest of the batch', async () => {
    const emailA: FixtureEmail = {
      gmailMessageId: `msg-a-${randomUUID()}`,
      subject: 'Your invoice A',
      attachmentId: 'att-a',
      filename: 'invoice-a.csv',
      mimeType: 'text/csv',
      data: Buffer.from(ATTACHMENT_CSV),
    };
    const emailB: FixtureEmail = {
      gmailMessageId: `msg-b-${randomUUID()}`,
      subject: 'Your invoice B',
      attachmentId: 'att-b',
      filename: 'invoice-b.pdf',
      mimeType: 'application/pdf',
      data: Buffer.alloc(0),
    };
    const emailC: FixtureEmail = {
      gmailMessageId: `msg-c-${randomUUID()}`,
      subject: 'Your invoice C',
      attachmentId: 'att-c',
      filename: 'invoice-c.csv',
      mimeType: 'text/csv',
      data: Buffer.from(ATTACHMENT_CSV),
    };

    const gmailClient = fakeGmailClientForBatch([emailA, emailB, emailC]);

    const summary = await runInvoiceCheck({ gmailClient, attachmentStore });

    expect(summary.invoicesProcessed).toBe(2);
    expect(summary.failures).toBe(1);

    const invoices = await prisma.invoice.findMany({ where: { vendorId } });
    expect(invoices).toHaveLength(2);

    const sourceEmailA = await prisma.sourceEmail.findUnique({
      where: { gmailMessageId: emailA.gmailMessageId },
      include: { invoice: true },
    });
    const sourceEmailB = await prisma.sourceEmail.findUnique({
      where: { gmailMessageId: emailB.gmailMessageId },
    });
    const sourceEmailC = await prisma.sourceEmail.findUnique({
      where: { gmailMessageId: emailC.gmailMessageId },
      include: { invoice: true },
    });

    expect(sourceEmailA?.invoice).not.toBeNull();
    expect(sourceEmailC?.invoice).not.toBeNull();

    const historyB = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmailB!.id },
    });
    expect(historyB).toHaveLength(1);
    expect(historyB[0]?.outcome).toBe('FAILED');
    expect(historyB[0]?.errorReason).toMatch(/PDF/i);

    const historyA = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmailA!.id },
    });
    expect(historyA).toHaveLength(1);
    expect(historyA[0]?.outcome).toBe('PROCESSED');

    const historyC = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmailC!.id },
    });
    expect(historyC).toHaveLength(1);
    expect(historyC[0]?.outcome).toBe('PROCESSED');
  });
});

describe('runInvoiceCheck retry logic (integration, real Postgres)', () => {
  let vendorId: string;
  let baseDir: string;
  let attachmentStore: InstanceType<typeof LocalAttachmentStore>;

  const VALID_EXTRACTION = {
    amount: '49.00',
    currency: 'USD',
    invoiceDate: '2026-06-01',
    extractionConfidence: 'HIGH' as const,
  };

  const ATTACHMENT_CSV = 'description,amount\nSeats,49.00\n';

  // isRecoverableError (invoiceMonitor.ts) only treats an AiExtractionError as recoverable when
  // it carries a `cause` matching a transient failure signature (timeout/rate-limit/deadlock, a
  // retryable HTTP status, or a retryable system error code) — this mirrors the real shape
  // aiExtractor.ts throws for an API-call failure vs. a terminal validation failure.
  function recoverableExtractionError(): InstanceType<typeof AiExtractionError> {
    return new AiExtractionError('Claude invoice extraction API call failed', {
      cause: new Error('Request timed out'),
    });
  }

  function permanentExtractionError(): InstanceType<typeof AiExtractionError> {
    return new AiExtractionError(
      'Claude invoice extraction failed validation after 3 attempts: amount is required',
    );
  }

  function fakeGmailClient(
    gmailMessageId: string,
  ): Pick<GmailClient, 'listMessages' | 'getMessage' | 'getAttachment'> {
    return {
      listMessages: vi
        .fn()
        .mockResolvedValue({ messages: [{ id: gmailMessageId, threadId: 'thread-1' }] }),
      getMessage: vi.fn().mockResolvedValue({
        id: gmailMessageId,
        threadId: 'thread-1',
        internalDate: String(Date.now()),
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'billing@testvendor.example' },
            { name: 'Subject', value: 'Your invoice' },
          ],
          parts: [
            {
              filename: 'invoice.csv',
              mimeType: 'text/csv',
              body: { attachmentId: 'att-1' },
            },
          ],
        },
      }),
      getAttachment: vi.fn().mockResolvedValue({
        size: Buffer.byteLength(ATTACHMENT_CSV),
        data: Buffer.from(ATTACHMENT_CSV).toString('base64url'),
      }),
    };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'sima-invoicemonitor-retry-test-'));
    attachmentStore = new LocalAttachmentStore(baseDir);
    extractInvoiceDataMock.mockReset();

    const vendor = await prisma.vendor.create({
      data: {
        name: `Test Vendor ${randomUUID()}`,
        senderPatterns: ['billing@testvendor.example'],
        subjectPatterns: [],
      },
    });
    vendorId = vendor.id;
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await prisma.processingHistoryEntry.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.attachment.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.invoice.deleteMany({ where: { vendorId } });
    await prisma.sourceEmail.deleteMany({ where: { vendorId } });
    await prisma.vendor.delete({ where: { id: vendorId } });
  });

  it('retries a recoverable failure up to the limit, then succeeds and records attemptNumber 3', async () => {
    extractInvoiceDataMock
      .mockRejectedValueOnce(recoverableExtractionError())
      .mockRejectedValueOnce(recoverableExtractionError())
      .mockResolvedValueOnce(VALID_EXTRACTION);

    const gmailMessageId = `msg-${randomUUID()}`;
    const gmailClient = fakeGmailClient(gmailMessageId);

    const summary = await runInvoiceCheck({ gmailClient, attachmentStore });

    expect(summary.invoicesProcessed).toBe(1);
    expect(summary.failures).toBe(0);
    expect(extractInvoiceDataMock).toHaveBeenCalledTimes(3);

    const invoices = await prisma.invoice.findMany({ where: { vendorId } });
    expect(invoices).toHaveLength(1);

    const sourceEmail = await prisma.sourceEmail.findUnique({
      where: { gmailMessageId },
    });
    const history = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmail!.id },
      orderBy: { attemptNumber: 'asc' },
    });

    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.outcome)).toEqual(['RETRYING', 'RETRYING', 'PROCESSED']);
    expect(history.map((entry) => entry.attemptNumber)).toEqual([1, 2, 3]);
    expect(history[2]?.invoiceId).toBe(invoices[0]!.id);
    expect(history[0]?.errorReason).toMatch(/AiExtractionError.*API call failed/i);
    expect(history[1]?.errorReason).toMatch(/AiExtractionError.*API call failed/i);
  });

  it('does not retry a permanent validation error and fails on attempt 1', async () => {
    extractInvoiceDataMock.mockRejectedValueOnce(permanentExtractionError());

    const gmailMessageId = `msg-${randomUUID()}`;
    const gmailClient = fakeGmailClient(gmailMessageId);

    const summary = await runInvoiceCheck({ gmailClient, attachmentStore });

    expect(summary.invoicesProcessed).toBe(0);
    expect(summary.failures).toBe(1);
    expect(extractInvoiceDataMock).toHaveBeenCalledTimes(1);

    const invoices = await prisma.invoice.findMany({ where: { vendorId } });
    expect(invoices).toHaveLength(0);

    const sourceEmail = await prisma.sourceEmail.findUnique({
      where: { gmailMessageId },
    });
    const history = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmail!.id },
      orderBy: { attemptNumber: 'asc' },
    });

    expect(history).toHaveLength(1);
    expect(history[0]?.outcome).toBe('FAILED');
    expect(history[0]?.attemptNumber).toBe(1);
    expect(history[0]?.errorReason).toMatch(/validation/i);
  });

  it('exhausts all 3 attempts on repeated recoverable failures and records FAILED at attemptNumber 3', async () => {
    extractInvoiceDataMock
      .mockRejectedValueOnce(recoverableExtractionError())
      .mockRejectedValueOnce(recoverableExtractionError())
      .mockRejectedValueOnce(recoverableExtractionError());

    const gmailMessageId = `msg-${randomUUID()}`;
    const gmailClient = fakeGmailClient(gmailMessageId);

    const summary = await runInvoiceCheck({ gmailClient, attachmentStore });

    expect(summary.invoicesProcessed).toBe(0);
    expect(summary.failures).toBe(1);
    expect(extractInvoiceDataMock).toHaveBeenCalledTimes(3);

    const invoices = await prisma.invoice.findMany({ where: { vendorId } });
    expect(invoices).toHaveLength(0);

    const sourceEmail = await prisma.sourceEmail.findUnique({
      where: { gmailMessageId },
    });
    const history = await prisma.processingHistoryEntry.findMany({
      where: { sourceEmailId: sourceEmail!.id },
      orderBy: { attemptNumber: 'asc' },
    });

    expect(history).toHaveLength(3);
    expect(history.map((entry) => entry.outcome)).toEqual(['RETRYING', 'RETRYING', 'FAILED']);
    expect(history.map((entry) => entry.attemptNumber)).toEqual([1, 2, 3]);
    expect(history[2]?.errorReason).toMatch(/AiExtractionError.*API call failed/i);
  });
});

describe('runInvoiceCheck summary counts (integration, real Postgres)', () => {
  let vendorId: string;
  let baseDir: string;
  let attachmentStore: InstanceType<typeof LocalAttachmentStore>;

  const VALID_EXTRACTION = {
    amount: '49.00',
    currency: 'USD',
    invoiceDate: '2026-06-01',
    extractionConfidence: 'HIGH' as const,
  };

  const ATTACHMENT_CSV = 'description,amount\nSeats,49.00\n';
  const VENDOR_SENDER = 'billing@testvendor.example';

  interface FixtureEmail {
    gmailMessageId: string;
    sender: string;
    subject: string;
    attachmentId: string;
    filename: string;
    mimeType: string;
    data: Buffer;
  }

  function fakeGmailClientForBatch(
    emails: FixtureEmail[],
  ): Pick<GmailClient, 'listMessages' | 'getMessage' | 'getAttachment'> {
    return {
      listMessages: vi.fn().mockResolvedValue({
        messages: emails.map((email) => ({ id: email.gmailMessageId, threadId: 'thread-1' })),
      }),
      getMessage: vi.fn().mockImplementation((messageId: string) => {
        const email = emails.find((candidate) => candidate.gmailMessageId === messageId);
        if (!email) throw new Error(`Unexpected messageId: ${messageId}`);
        return {
          id: email.gmailMessageId,
          threadId: 'thread-1',
          internalDate: String(Date.now()),
          payload: {
            mimeType: 'multipart/mixed',
            headers: [
              { name: 'From', value: email.sender },
              { name: 'Subject', value: email.subject },
            ],
            parts: [
              {
                filename: email.filename,
                mimeType: email.mimeType,
                body: { attachmentId: email.attachmentId },
              },
            ],
          },
        };
      }),
      getAttachment: vi.fn().mockImplementation((_messageId: string, attachmentId: string) => {
        const email = emails.find((candidate) => candidate.attachmentId === attachmentId);
        if (!email) throw new Error(`Unexpected attachmentId: ${attachmentId}`);
        return {
          size: email.data.length,
          data: email.data.toString('base64url'),
        };
      }),
    };
  }

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'sima-invoicemonitor-summary-test-'));
    attachmentStore = new LocalAttachmentStore(baseDir);
    extractInvoiceDataMock.mockReset().mockResolvedValue(VALID_EXTRACTION);

    const vendor = await prisma.vendor.create({
      data: {
        name: `Test Vendor ${randomUUID()}`,
        senderPatterns: [VENDOR_SENDER],
        subjectPatterns: [],
      },
    });
    vendorId = vendor.id;
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
    await prisma.processingHistoryEntry.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.attachment.deleteMany({ where: { sourceEmail: { vendorId } } });
    await prisma.invoice.deleteMany({ where: { vendorId } });
    await prisma.sourceEmail.deleteMany({ where: { vendorId } });
    await prisma.vendor.delete({ where: { id: vendorId } });
  });

  it('computes scanned/processed/duplicates/failures/skipped and a positive duration for a mixed batch of 5 emails', async () => {
    const emailProcessed1: FixtureEmail = {
      gmailMessageId: `msg-p1-${randomUUID()}`,
      sender: VENDOR_SENDER,
      subject: 'Your invoice 1',
      attachmentId: 'att-p1',
      filename: 'invoice-1.csv',
      mimeType: 'text/csv',
      data: Buffer.from(ATTACHMENT_CSV),
    };
    const emailProcessed2: FixtureEmail = {
      gmailMessageId: `msg-p2-${randomUUID()}`,
      sender: VENDOR_SENDER,
      subject: 'Your invoice 2',
      attachmentId: 'att-p2',
      filename: 'invoice-2.csv',
      mimeType: 'text/csv',
      data: Buffer.from(ATTACHMENT_CSV),
    };
    // Zero-byte "PDF" is rejected by extractPdfText as unparseable (see the per-email isolation
    // test above) — a deterministic, non-recoverable failure on attempt 1.
    const emailFailed: FixtureEmail = {
      gmailMessageId: `msg-f-${randomUUID()}`,
      sender: VENDOR_SENDER,
      subject: 'Your invoice (broken)',
      attachmentId: 'att-f',
      filename: 'invoice-broken.pdf',
      mimeType: 'application/pdf',
      data: Buffer.alloc(0),
    };
    // Sender matches no configured vendor, so findMatchingVendor returns undefined and the email
    // is recorded SKIPPED_NOT_INVOICE.
    const emailSkippedNotInvoice: FixtureEmail = {
      gmailMessageId: `msg-s-${randomUUID()}`,
      sender: 'no-vendor-match@unrelated.example',
      subject: 'Not an invoice',
      attachmentId: 'att-s',
      filename: 'newsletter.csv',
      mimeType: 'text/csv',
      data: Buffer.from(ATTACHMENT_CSV),
    };
    const emailDuplicate: FixtureEmail = {
      gmailMessageId: `msg-d-${randomUUID()}`,
      sender: VENDOR_SENDER,
      subject: 'Your invoice (already processed)',
      attachmentId: 'att-d',
      filename: 'invoice-d.csv',
      mimeType: 'text/csv',
      data: Buffer.from(ATTACHMENT_CSV),
    };

    // Pre-seed emailDuplicate as already-processed (SourceEmail + Invoice + a prior PROCESSED
    // ProcessingHistoryEntry) so this run's evaluation of it takes the SKIPPED_DUPLICATE branch.
    const priorSourceEmail = await prisma.sourceEmail.create({
      data: {
        gmailMessageId: emailDuplicate.gmailMessageId,
        vendorId,
        sender: emailDuplicate.sender,
        subject: emailDuplicate.subject,
        receivedAt: new Date(),
      },
    });
    const priorInvoice = await prisma.invoice.create({
      data: {
        sourceEmailId: priorSourceEmail.id,
        vendorId,
        amount: VALID_EXTRACTION.amount,
        currency: VALID_EXTRACTION.currency,
        invoiceDate: new Date(VALID_EXTRACTION.invoiceDate),
        extractionConfidence: VALID_EXTRACTION.extractionConfidence,
      },
    });
    await prisma.processingHistoryEntry.create({
      data: {
        sourceEmailId: priorSourceEmail.id,
        invoiceId: priorInvoice.id,
        outcome: 'PROCESSED',
        attemptNumber: 1,
        evaluatedAt: new Date(),
      },
    });

    const gmailClient = fakeGmailClientForBatch([
      emailProcessed1,
      emailProcessed2,
      emailFailed,
      emailSkippedNotInvoice,
      emailDuplicate,
    ]);

    const summary = await runInvoiceCheck({ gmailClient, attachmentStore });

    expect(summary.emailsScanned).toBe(5);
    expect(summary.invoicesProcessed).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.duplicateEmails).toBe(1);
    // `skipped` counts every SKIPPED_* outcome (both SKIPPED_NOT_INVOICE and SKIPPED_DUPLICATE —
    // see the duplicate-detection branch in processCandidateEmail), so it's the not-invoice skip
    // plus the duplicate, not a bucket disjoint from `duplicateEmails`.
    expect(summary.skipped).toBe(2);

    expect(summary.durationMs).toBeGreaterThan(0);
    const startedAtMs = new Date(summary.startedAt).getTime();
    const finishedAtMs = new Date(summary.finishedAt).getTime();
    expect(finishedAtMs).toBeGreaterThan(startedAtMs);
    expect(summary.durationMs).toBe(finishedAtMs - startedAtMs);
  });
});
