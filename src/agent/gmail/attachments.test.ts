import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Storage } from '@google-cloud/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GCS_BUCKET_NAME: 'test-bucket',
    ATTACHMENT_STORE_LOCAL_DIR: '.data/attachments-test',
  },
}));

const { GcsAttachmentStore } = await import('../../storage/gcsAttachmentStore.js');
const { LocalAttachmentStore } = await import('../../storage/localAttachmentStore.js');
const { downloadMessageAttachments, findAttachmentParts } = await import('./attachments.js');
import type { GmailAttachment, GmailMessagePart } from './client.js';
import type { GmailAttachmentFetcher } from './attachments.js';

function toBase64Url(text: string): string {
  return Buffer.from(text).toString('base64url');
}

function makeGmailAttachment(text: string): GmailAttachment {
  const data = toBase64Url(text);
  return { size: Buffer.byteLength(text), data };
}

describe('findAttachmentParts', () => {
  it('returns an empty list when there is no payload', () => {
    expect(findAttachmentParts(undefined)).toEqual([]);
  });

  it('finds a single attachment part on a flat payload', () => {
    const payload: GmailMessagePart = {
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
      body: { attachmentId: 'att1', size: 123 },
    };

    expect(findAttachmentParts(payload)).toEqual([
      { attachmentId: 'att1', filename: 'invoice.pdf', mimeType: 'application/pdf' },
    ]);
  });

  it('skips inline parts that have no filename (e.g. text/html body)', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/html', body: { data: 'aGVsbG8' } },
        {
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          body: { attachmentId: 'att1', size: 123 },
        },
      ],
    };

    expect(findAttachmentParts(payload)).toEqual([
      { attachmentId: 'att1', filename: 'invoice.pdf', mimeType: 'application/pdf' },
    ]);
  });

  it('walks nested multipart trees to find deeply nested attachments', () => {
    const payload: GmailMessagePart = {
      mimeType: 'multipart/mixed',
      parts: [
        {
          mimeType: 'multipart/alternative',
          parts: [{ mimeType: 'text/plain', body: { data: 'aGk' } }],
        },
        {
          mimeType: 'application/vnd.ms-excel',
          filename: 'usage.csv',
          body: { attachmentId: 'att2', size: 456 },
        },
      ],
    };

    expect(findAttachmentParts(payload)).toEqual([
      { attachmentId: 'att2', filename: 'usage.csv', mimeType: 'application/vnd.ms-excel' },
    ]);
  });

  it('defaults to application/octet-stream when mimeType is missing', () => {
    const payload: GmailMessagePart = {
      filename: 'mystery.bin',
      body: { attachmentId: 'att3' },
    };

    expect(findAttachmentParts(payload)).toEqual([
      { attachmentId: 'att3', filename: 'mystery.bin', mimeType: 'application/octet-stream' },
    ]);
  });

  it('ignores a filename with no attachmentId', () => {
    const payload: GmailMessagePart = {
      filename: 'not-really-an-attachment.txt',
      body: {},
    };

    expect(findAttachmentParts(payload)).toEqual([]);
  });
});

describe('downloadMessageAttachments', () => {
  it('returns an empty list and never calls Gmail when the message has no attachments', async () => {
    const getAttachment = vi.fn();
    const client: GmailAttachmentFetcher = { getAttachment };
    const store = new LocalAttachmentStore(await mkdtemp(path.join(tmpdir(), 'sima-test-')));

    const result = await downloadMessageAttachments(client, store, 'msg1', undefined);

    expect(result).toEqual([]);
    expect(getAttachment).not.toHaveBeenCalled();
  });

  describe('with LocalAttachmentStore', () => {
    let baseDir: string;
    let store: InstanceType<typeof LocalAttachmentStore>;

    beforeEach(async () => {
      baseDir = await mkdtemp(path.join(tmpdir(), 'sima-attachments-test-'));
      store = new LocalAttachmentStore(baseDir);
    });

    afterEach(async () => {
      await rm(baseDir, { recursive: true, force: true });
    });

    it('downloads and stores each attachment, returning storage metadata in part order', async () => {
      const payload: GmailMessagePart = {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'application/pdf',
            filename: 'invoice.pdf',
            body: { attachmentId: 'att-pdf', size: 20 },
          },
          {
            mimeType: 'text/csv',
            filename: 'usage.csv',
            body: { attachmentId: 'att-csv', size: 10 },
          },
        ],
      };
      const getAttachment = vi
        .fn()
        .mockImplementation((_messageId: string, attachmentId: string) =>
          Promise.resolve(
            attachmentId === 'att-pdf'
              ? makeGmailAttachment('%PDF-1.4 fake bytes')
              : makeGmailAttachment('a,b\n1,2'),
          ),
        );
      const client: GmailAttachmentFetcher = { getAttachment };

      const results = await downloadMessageAttachments(client, store, 'msg1', payload);

      expect(getAttachment).toHaveBeenNthCalledWith(1, 'msg1', 'att-pdf');
      expect(getAttachment).toHaveBeenNthCalledWith(2, 'msg1', 'att-csv');
      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({ filename: 'invoice.pdf', mimeType: 'application/pdf' });
      expect(results[1]).toMatchObject({ filename: 'usage.csv', mimeType: 'text/csv' });

      const stored = await store.retrieve(results[0]!.storageRef);
      expect(stored.toString()).toBe('%PDF-1.4 fake bytes');
    });

    it('decodes the base64url-encoded attachment payload correctly', async () => {
      const payload: GmailMessagePart = {
        filename: 'binary.bin',
        mimeType: 'application/octet-stream',
        body: { attachmentId: 'att-bin' },
      };
      // Bytes that differ between base64 and base64url alphabets (0xFB 0xFF -> "+/" in base64).
      const rawBytes = Buffer.from([0xfb, 0xff, 0xfe]);
      const getAttachment = vi
        .fn()
        .mockResolvedValue({ size: rawBytes.length, data: rawBytes.toString('base64url') });
      const client: GmailAttachmentFetcher = { getAttachment };

      const results = await downloadMessageAttachments(client, store, 'msg1', payload);

      const stored = await store.retrieve(results[0]!.storageRef);
      expect(stored.equals(rawBytes)).toBe(true);
    });
  });

  describe('with GcsAttachmentStore', () => {
    function createFakeStorage() {
      const file = {
        save: vi.fn().mockResolvedValue(undefined),
      };
      const bucket = { file: vi.fn().mockReturnValue(file) };
      const storage = { bucket: vi.fn().mockReturnValue(bucket) };
      return { storage: storage as unknown as Storage, file };
    }

    it('downloads and uploads each attachment to GCS', async () => {
      const { storage, file } = createFakeStorage();
      const store = new GcsAttachmentStore('test-bucket', storage);
      const payload: GmailMessagePart = {
        mimeType: 'application/pdf',
        filename: 'invoice.pdf',
        body: { attachmentId: 'att-pdf', size: 20 },
      };
      const getAttachment = vi.fn().mockResolvedValue(makeGmailAttachment('%PDF-1.4 fake bytes'));
      const client: GmailAttachmentFetcher = { getAttachment };

      const results = await downloadMessageAttachments(client, store, 'msg1', payload);

      expect(getAttachment).toHaveBeenCalledWith('msg1', 'att-pdf');
      expect(file.save).toHaveBeenCalledWith(
        Buffer.from('%PDF-1.4 fake bytes'),
        expect.objectContaining({ contentType: 'application/pdf' }),
      );
      expect(results).toEqual([
        expect.objectContaining({ filename: 'invoice.pdf', mimeType: 'application/pdf' }),
      ]);
    });
  });
});
