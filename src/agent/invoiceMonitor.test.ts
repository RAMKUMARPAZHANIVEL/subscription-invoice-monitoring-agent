import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
vi.mock('./extraction/aiExtractor.js', () => ({
  extractInvoiceData: extractInvoiceDataMock,
}));

const { LocalAttachmentStore } = await import('../storage/localAttachmentStore.js');
const { prisma } = await import('../storage/prisma.js');
const { buildSourceText, classifyAttachmentType, extractBodyText, getHeader, runInvoiceCheck } =
  await import('./invoiceMonitor.js');
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
