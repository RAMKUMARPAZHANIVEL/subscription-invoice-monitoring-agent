/**
 * Gmail attachment download (FR-003, FR-006) — walks a message's MIME part tree to find
 * attachment parts, downloads each via `GmailClient.getAttachment`, and persists it through the
 * injected `AttachmentStore` so this module stays agnostic to Local vs GCS storage.
 */

import { logger } from '../../lib/logger.js';
import type { AttachmentMetadata, AttachmentStore } from '../../storage/attachmentStore.js';
import type { GmailAttachment, GmailClient, GmailMessagePart } from './client.js';

/** The subset of `GmailClient` attachment download needs — keeps this module easy to test. */
export type GmailAttachmentFetcher = Pick<GmailClient, 'getAttachment'>;

export interface AttachmentPart {
  attachmentId: string;
  filename: string;
  mimeType: string;
}

/**
 * Recursively walks a message's MIME part tree, collecting parts that carry a downloadable
 * attachment (both a `filename` and a `body.attachmentId` — inline content without a filename,
 * e.g. HTML/text bodies, is not an attachment and is skipped).
 */
export function findAttachmentParts(payload: GmailMessagePart | undefined): AttachmentPart[] {
  if (!payload) return [];

  const parts: AttachmentPart[] = [];

  function walk(part: GmailMessagePart): void {
    const attachmentId = part.body?.attachmentId;
    if (part.filename && attachmentId) {
      parts.push({
        attachmentId,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
      });
    }
    part.parts?.forEach(walk);
  }

  walk(payload);
  return parts;
}

/** Decodes the Gmail API's base64url-encoded attachment payload into raw bytes. */
function decodeAttachmentData(attachment: GmailAttachment): Buffer {
  return Buffer.from(attachment.data, 'base64url');
}

/**
 * Downloads every attachment on a Gmail message and persists it via the given `AttachmentStore`.
 * Returns the resulting storage metadata for each attachment, in the message's part order.
 */
export async function downloadMessageAttachments(
  client: GmailAttachmentFetcher,
  store: AttachmentStore,
  messageId: string,
  payload: GmailMessagePart | undefined,
): Promise<AttachmentMetadata[]> {
  const attachmentParts = findAttachmentParts(payload);
  const results: AttachmentMetadata[] = [];

  for (const part of attachmentParts) {
    const attachment = await client.getAttachment(messageId, part.attachmentId);
    const data = decodeAttachmentData(attachment);

    const metadata = await store.save({
      filename: part.filename,
      mimeType: part.mimeType,
      data,
    });

    logger.info(
      {
        messageId,
        filename: part.filename,
        mimeType: part.mimeType,
        storageRef: metadata.storageRef,
        sizeBytes: metadata.sizeBytes,
      },
      'Downloaded and stored Gmail attachment',
    );

    results.push(metadata);
  }

  return results;
}
