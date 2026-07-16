import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Storage } from '@google-cloud/storage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GCS_BUCKET_NAME: 'test-bucket',
    ATTACHMENT_STORE_LOCAL_DIR: '.data/attachments-test',
  },
}));

const { GcsAttachmentStore } = await import('./gcsAttachmentStore.js');
const { LocalAttachmentStore } = await import('./localAttachmentStore.js');
import type { AttachmentInput } from './attachmentStore.js';

function makeInput(overrides: Partial<AttachmentInput> = {}): AttachmentInput {
  return {
    filename: 'invoice.pdf',
    mimeType: 'application/pdf',
    data: Buffer.from('%PDF-1.4 fake attachment bytes'),
    ...overrides,
  };
}

interface FakeGcsFile {
  save: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  getMetadata: ReturnType<typeof vi.fn>;
}

function createFakeStorage(overrides: Partial<FakeGcsFile> = {}) {
  const file: FakeGcsFile = {
    save: vi.fn().mockResolvedValue(undefined),
    download: vi.fn().mockResolvedValue([Buffer.from('downloaded bytes')]),
    delete: vi.fn().mockResolvedValue(undefined),
    getMetadata: vi.fn().mockResolvedValue([
      {
        contentType: 'application/pdf',
        size: '17',
        metadata: { originalFilename: 'invoice.pdf' },
      },
    ]),
    ...overrides,
  };
  const bucket = { file: vi.fn().mockReturnValue(file) };
  const storage = { bucket: vi.fn().mockReturnValue(bucket) };
  return { storage: storage as unknown as Storage, bucket, file };
}

describe('GcsAttachmentStore', () => {
  it('uploads attachment bytes and returns storage metadata', async () => {
    const { storage, bucket, file } = createFakeStorage();
    const store = new GcsAttachmentStore('test-bucket', storage);
    const input = makeInput();

    const result = await store.save(input);

    expect(bucket.file).toHaveBeenCalledWith(result.storageRef);
    expect(result.storageRef).toMatch(/^attachments\/.+-invoice\.pdf$/);
    expect(result.filename).toBe(input.filename);
    expect(result.mimeType).toBe(input.mimeType);
    expect(result.sizeBytes).toBe(input.data.length);
    expect(file.save).toHaveBeenCalledWith(
      input.data,
      expect.objectContaining({ contentType: input.mimeType }),
    );
  });

  it('wraps upload errors with a descriptive message', async () => {
    const { storage } = createFakeStorage({ save: vi.fn().mockRejectedValue(new Error('boom')) });
    const store = new GcsAttachmentStore('test-bucket', storage);

    await expect(store.save(makeInput())).rejects.toThrow(/Failed to upload attachment/);
  });

  it('downloads previously saved attachment bytes', async () => {
    const { storage, file } = createFakeStorage({
      download: vi.fn().mockResolvedValue([Buffer.from('hello world')]),
    });
    const store = new GcsAttachmentStore('test-bucket', storage);

    const data = await store.retrieve('attachments/abc-invoice.pdf');

    expect(file.download).toHaveBeenCalled();
    expect(data.toString()).toBe('hello world');
  });

  it('wraps download errors for missing files', async () => {
    const { storage } = createFakeStorage({
      download: vi.fn().mockRejectedValue(new Error('No such object')),
    });
    const store = new GcsAttachmentStore('test-bucket', storage);

    await expect(store.retrieve('attachments/does-not-exist.pdf')).rejects.toThrow(
      /Failed to download attachment "attachments\/does-not-exist\.pdf"/,
    );
  });

  it('wraps download errors for invalid storage paths', async () => {
    const { storage, bucket } = createFakeStorage({
      download: vi.fn().mockRejectedValue(new Error('Invalid bucket name')),
    });
    const store = new GcsAttachmentStore('test-bucket', storage);

    await expect(store.retrieve('')).rejects.toThrow(/Failed to download attachment/);
    expect(bucket.file).toHaveBeenCalledWith('');
  });

  it('deletes a previously saved attachment', async () => {
    const { storage, file } = createFakeStorage();
    const store = new GcsAttachmentStore('test-bucket', storage);

    await store.delete('attachments/abc-invoice.pdf');

    expect(file.delete).toHaveBeenCalled();
  });

  it('wraps delete errors for missing files', async () => {
    const { storage } = createFakeStorage({
      delete: vi.fn().mockRejectedValue(new Error('No such object')),
    });
    const store = new GcsAttachmentStore('test-bucket', storage);

    await expect(store.delete('attachments/does-not-exist.pdf')).rejects.toThrow(
      /Failed to delete attachment/,
    );
  });

  it('fetches metadata for a previously saved attachment', async () => {
    const { storage } = createFakeStorage();
    const store = new GcsAttachmentStore('test-bucket', storage);

    const metadata = await store.getMetadata('attachments/abc-invoice.pdf');

    expect(metadata).toEqual({
      storageRef: 'attachments/abc-invoice.pdf',
      filename: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 17,
    });
  });

  it('falls back to the storage ref and default mime type when GCS metadata is sparse', async () => {
    const { storage } = createFakeStorage({
      getMetadata: vi.fn().mockResolvedValue([{}]),
    });
    const store = new GcsAttachmentStore('test-bucket', storage);

    const metadata = await store.getMetadata('attachments/no-metadata.pdf');

    expect(metadata).toEqual({
      storageRef: 'attachments/no-metadata.pdf',
      filename: 'attachments/no-metadata.pdf',
      mimeType: 'application/octet-stream',
      sizeBytes: 0,
    });
  });

  it('wraps getMetadata errors for missing files', async () => {
    const { storage } = createFakeStorage({
      getMetadata: vi.fn().mockRejectedValue(new Error('No such object')),
    });
    const store = new GcsAttachmentStore('test-bucket', storage);

    await expect(store.getMetadata('attachments/does-not-exist.pdf')).rejects.toThrow(
      /Failed to fetch metadata for attachment/,
    );
  });
});

describe('LocalAttachmentStore', () => {
  let baseDir: string;
  let store: InstanceType<typeof LocalAttachmentStore>;

  beforeEach(async () => {
    baseDir = await mkdtemp(path.join(tmpdir(), 'attachment-store-test-'));
    store = new LocalAttachmentStore(baseDir);
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('saves attachment bytes to disk and returns storage metadata', async () => {
    const input = makeInput();

    const result = await store.save(input);

    expect(result.storageRef).toMatch(/-invoice\.pdf$/);
    expect(result.filename).toBe(input.filename);
    expect(result.mimeType).toBe(input.mimeType);
    expect(result.sizeBytes).toBe(input.data.length);
  });

  it('round-trips saved bytes through retrieve', async () => {
    const input = makeInput({ data: Buffer.from('round trip contents') });

    const { storageRef } = await store.save(input);
    const data = await store.retrieve(storageRef);

    expect(data.toString()).toBe('round trip contents');
  });

  it('returns metadata matching the saved attachment', async () => {
    const input = makeInput();

    const { storageRef } = await store.save(input);
    const metadata = await store.getMetadata(storageRef);

    expect(metadata).toEqual({
      storageRef,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
    });
  });

  it('deletes a saved attachment so it can no longer be retrieved', async () => {
    const { storageRef } = await store.save(makeInput());

    await store.delete(storageRef);

    await expect(store.retrieve(storageRef)).rejects.toThrow(
      /Failed to read attachment .* from local storage/,
    );
  });

  it('throws a wrapped error when retrieving a missing file', async () => {
    await expect(store.retrieve('does-not-exist.pdf')).rejects.toThrow(
      /Failed to read attachment "does-not-exist\.pdf" from local storage/,
    );
  });

  it('throws a wrapped error when fetching metadata for a missing file', async () => {
    await expect(store.getMetadata('does-not-exist.pdf')).rejects.toThrow(
      /Failed to fetch metadata for attachment "does-not-exist\.pdf" from local storage/,
    );
  });

  it('throws a wrapped error when deleting a missing file', async () => {
    await expect(store.delete('does-not-exist.pdf')).rejects.toThrow(
      /Failed to delete attachment "does-not-exist\.pdf" from local storage/,
    );
  });

  it('throws a wrapped error for a malformed storage ref that resolves to a missing path', async () => {
    await expect(store.retrieve('nested/../../invalid-ref.pdf')).rejects.toThrow(
      /Failed to read attachment/,
    );
  });

  it('preserves the underlying filesystem error as the cause', async () => {
    try {
      await store.retrieve('does-not-exist.pdf');
      expect.unreachable('expected retrieve to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).cause).toBeDefined();
    }
  });
});
