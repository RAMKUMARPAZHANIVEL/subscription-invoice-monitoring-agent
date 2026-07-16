/**
 * Google Cloud Storage-backed implementation of {@link AttachmentStore} (research.md #7).
 *
 * Every deployed environment uses this store; bucket name and project come from `env.ts` only.
 */

import { randomUUID } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { AttachmentInput, AttachmentMetadata, AttachmentStore } from './attachmentStore.js';

export class GcsAttachmentStore implements AttachmentStore {
  private readonly storage: Storage;
  private readonly bucketName: string;

  constructor(bucketName: string = env.GCS_BUCKET_NAME, storage?: Storage) {
    this.bucketName = bucketName;
    this.storage =
      storage ??
      new Storage(env.GOOGLE_CLOUD_PROJECT ? { projectId: env.GOOGLE_CLOUD_PROJECT } : {});
  }

  async save(input: AttachmentInput): Promise<AttachmentMetadata> {
    const storageRef = `attachments/${randomUUID()}-${input.filename}`;
    const file = this.storage.bucket(this.bucketName).file(storageRef);

    try {
      await file.save(input.data, {
        contentType: input.mimeType,
        resumable: false,
        metadata: { metadata: { originalFilename: input.filename } },
      });
    } catch (err) {
      logger.error(
        { err, storageRef, bucket: this.bucketName, filename: input.filename },
        'Failed to upload attachment to GCS',
      );
      throw new Error(`Failed to upload attachment "${input.filename}" to GCS`, { cause: err });
    }

    logger.info(
      { storageRef, bucket: this.bucketName, sizeBytes: input.data.length },
      'Uploaded attachment to GCS',
    );

    return {
      storageRef,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
    };
  }

  async retrieve(storageRef: string): Promise<Buffer> {
    const file = this.storage.bucket(this.bucketName).file(storageRef);

    try {
      const [data] = await file.download();
      logger.info(
        { storageRef, bucket: this.bucketName, sizeBytes: data.length },
        'Downloaded attachment from GCS',
      );
      return data;
    } catch (err) {
      logger.error(
        { err, storageRef, bucket: this.bucketName },
        'Failed to download attachment from GCS',
      );
      throw new Error(`Failed to download attachment "${storageRef}" from GCS`, { cause: err });
    }
  }

  async delete(storageRef: string): Promise<void> {
    const file = this.storage.bucket(this.bucketName).file(storageRef);

    try {
      await file.delete();
      logger.info({ storageRef, bucket: this.bucketName }, 'Deleted attachment from GCS');
    } catch (err) {
      logger.error(
        { err, storageRef, bucket: this.bucketName },
        'Failed to delete attachment from GCS',
      );
      throw new Error(`Failed to delete attachment "${storageRef}" from GCS`, { cause: err });
    }
  }

  async getMetadata(storageRef: string): Promise<AttachmentMetadata> {
    const file = this.storage.bucket(this.bucketName).file(storageRef);

    try {
      const [metadata] = await file.getMetadata();
      const filename = (metadata.metadata?.originalFilename as string | undefined) ?? storageRef;

      return {
        storageRef,
        filename,
        mimeType: metadata.contentType ?? 'application/octet-stream',
        sizeBytes: Number(metadata.size ?? 0),
      };
    } catch (err) {
      logger.error(
        { err, storageRef, bucket: this.bucketName },
        'Failed to fetch attachment metadata from GCS',
      );
      throw new Error(`Failed to fetch metadata for attachment "${storageRef}" from GCS`, {
        cause: err,
      });
    }
  }
}
