/**
 * Storage abstraction for invoice attachments (research.md #7).
 *
 * Concrete providers (e.g. `GcsAttachmentStore`, `LocalAttachmentStore`) implement this
 * interface. This file defines the contract only — no storage provider lives here.
 */

/** Bytes to persist for a new attachment, plus the descriptive fields needed to store it. */
export interface AttachmentInput {
  /** Original attachment filename as received (e.g. from the source email). */
  filename: string;
  /** IANA media type, e.g. `application/pdf`, `text/csv`. */
  mimeType: string;
  /** Raw attachment bytes. */
  data: Buffer;
}

/**
 * Metadata describing a stored attachment. `storageRef` is the opaque reference a store
 * hands back for later `retrieve`/`delete`/`getMetadata` calls (persisted as
 * `Attachment.storageRef` — see data-model.md).
 */
export interface AttachmentMetadata {
  storageRef: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

export interface AttachmentStore {
  /** Persist attachment bytes and return the resulting storage metadata. */
  save(input: AttachmentInput): Promise<AttachmentMetadata>;

  /** Fetch the raw bytes for a previously saved attachment. */
  retrieve(storageRef: string): Promise<Buffer>;

  /** Remove a previously saved attachment. */
  delete(storageRef: string): Promise<void>;

  /** Fetch storage metadata for a previously saved attachment without reading its bytes. */
  getMetadata(storageRef: string): Promise<AttachmentMetadata>;
}
