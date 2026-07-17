import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// invoiceMonitor.ts transitively imports env.ts (via the Gmail client, Prisma, and the
// attachment stores); mock it so this file's pure-function tests don't require a full
// Gmail/DB/GCS environment to be configured, matching gmail/attachments.test.ts's pattern.
vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
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

const { LocalAttachmentStore } = await import('../storage/localAttachmentStore.js');
const { buildSourceText, classifyAttachmentType, extractBodyText, getHeader } =
  await import('./invoiceMonitor.js');
import type { GmailMessagePart } from './gmail/client.js';

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
