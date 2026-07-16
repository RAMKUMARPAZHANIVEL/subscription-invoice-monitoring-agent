/**
 * Filesystem-backed implementation of {@link AttachmentStore} (research.md #7).
 *
 * Intended for local development and testing only — not for production use, which uses
 * `GcsAttachmentStore` instead.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import type { AttachmentInput, AttachmentMetadata, AttachmentStore } from './attachmentStore.js';

interface StoredMetadata {
  filename: string;
  mimeType: string;
}

export class LocalAttachmentStore implements AttachmentStore {
  private readonly baseDir: string;

  constructor(baseDir: string = env.ATTACHMENT_STORE_LOCAL_DIR) {
    this.baseDir = baseDir;
  }

  private dataPath(storageRef: string): string {
    return path.join(this.baseDir, storageRef);
  }

  private metaPath(storageRef: string): string {
    return path.join(this.baseDir, `${storageRef}.meta.json`);
  }

  async save(input: AttachmentInput): Promise<AttachmentMetadata> {
    const storageRef = `${randomUUID()}-${input.filename}`;
    const metadata: StoredMetadata = { filename: input.filename, mimeType: input.mimeType };

    try {
      await mkdir(this.baseDir, { recursive: true });
      await writeFile(this.dataPath(storageRef), input.data);
      await writeFile(this.metaPath(storageRef), JSON.stringify(metadata));
    } catch (err) {
      logger.error(
        { err, storageRef, baseDir: this.baseDir, filename: input.filename },
        'Failed to save attachment to local storage',
      );
      throw new Error(`Failed to save attachment "${input.filename}" to local storage`, {
        cause: err,
      });
    }

    logger.info(
      { storageRef, baseDir: this.baseDir, sizeBytes: input.data.length },
      'Saved attachment to local storage',
    );

    return {
      storageRef,
      filename: input.filename,
      mimeType: input.mimeType,
      sizeBytes: input.data.length,
    };
  }

  async retrieve(storageRef: string): Promise<Buffer> {
    try {
      const data = await readFile(this.dataPath(storageRef));
      logger.info(
        { storageRef, baseDir: this.baseDir, sizeBytes: data.length },
        'Read attachment from local storage',
      );
      return data;
    } catch (err) {
      logger.error(
        { err, storageRef, baseDir: this.baseDir },
        'Failed to read attachment from local storage',
      );
      throw new Error(`Failed to read attachment "${storageRef}" from local storage`, {
        cause: err,
      });
    }
  }

  async delete(storageRef: string): Promise<void> {
    try {
      await unlink(this.dataPath(storageRef));
      await unlink(this.metaPath(storageRef)).catch(() => undefined);
      logger.info({ storageRef, baseDir: this.baseDir }, 'Deleted attachment from local storage');
    } catch (err) {
      logger.error(
        { err, storageRef, baseDir: this.baseDir },
        'Failed to delete attachment from local storage',
      );
      throw new Error(`Failed to delete attachment "${storageRef}" from local storage`, {
        cause: err,
      });
    }
  }

  async getMetadata(storageRef: string): Promise<AttachmentMetadata> {
    try {
      const [stats, metaRaw] = await Promise.all([
        stat(this.dataPath(storageRef)),
        readFile(this.metaPath(storageRef), 'utf-8'),
      ]);
      const meta = JSON.parse(metaRaw) as StoredMetadata;

      return {
        storageRef,
        filename: meta.filename,
        mimeType: meta.mimeType,
        sizeBytes: stats.size,
      };
    } catch (err) {
      logger.error(
        { err, storageRef, baseDir: this.baseDir },
        'Failed to fetch attachment metadata from local storage',
      );
      throw new Error(
        `Failed to fetch metadata for attachment "${storageRef}" from local storage`,
        {
          cause: err,
        },
      );
    }
  }
}
