/**
 * Invoice ingestion run orchestrator (spec.md US1/US2, data-model.md, research.md #9) — the single
 * entry point (`runInvoiceCheck`) that coordinates discovery → download → extraction → persistence
 * for one scheduled pass over the admin Gmail account.
 *
 * Per-email processing is isolated (try/catch per candidate) so one bad email never aborts the
 * rest of the run (constitution Principle I), and every evaluated email produces exactly one
 * `ProcessingHistoryEntry` (Principle VI). `SourceEmail` is upserted by `gmailMessageId` before any
 * extraction work happens, which is what makes retries/re-runs safe (research.md #9, Principle II).
 */

import { randomUUID } from 'node:crypto';
import { env } from '../config/env.js';
import { Prisma } from '../generated/prisma/client.js';
import { logger } from '../lib/logger.js';
import type { AttachmentMetadata, AttachmentStore } from '../storage/attachmentStore.js';
import { GcsAttachmentStore } from '../storage/gcsAttachmentStore.js';
import { LocalAttachmentStore } from '../storage/localAttachmentStore.js';
import { prisma } from '../storage/prisma.js';
import { downloadMessageAttachments } from './gmail/attachments.js';
import { GmailClient, type GmailMessagePart } from './gmail/client.js';
import { discoverCandidateEmails, type CandidateEmailRef } from './gmail/discovery.js';
import { AiExtractionError, extractInvoiceData } from './extraction/aiExtractor.js';
import { extractCsvData } from './extraction/csvExtractor.js';
import { extractPdfText } from './extraction/pdfExtractor.js';
import { findMatchingVendor, loadEnabledVendors, type Vendor } from './vendors/vendorConfig.js';

/**
 * T037 (US3): recoverable-failure retry for one email's extraction/persistence attempt. Only
 * failures that are plausibly transient — Gmail rate limits, Claude/Bedrock timeouts, Cloud
 * Storage timeouts, Postgres deadlocks/serialization conflicts — are retried; invalid invoice
 * data, malformed attachments, and Zod validation failures are terminal and fail immediately
 * (retrying can never fix them). Matches the backoff schedule in data-model.md's `RETRYING`
 * outcome: attempt 1 immediately, attempt 2 after 500ms, attempt 3 after 1000ms.
 */
const MAX_PROCESSING_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [0, 500, 1000];

const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_SYSTEM_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE']);
// Postgres deadlock/serialization write conflict surfaced through Prisma's interactive
// transactions: https://www.prisma.io/docs/orm/reference/error-reference#p2034
const RETRYABLE_PRISMA_CODES = new Set(['P2034']);
const RECOVERABLE_MESSAGE_PATTERN = /(rate limit|timed?\s*out|timeout|deadlock)/i;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getHttpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const candidate = err as {
    status?: unknown;
    response?: { status?: unknown };
    $metadata?: { httpStatusCode?: unknown };
  };
  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.response?.status === 'number') return candidate.response.status;
  if (typeof candidate.$metadata?.httpStatusCode === 'number') {
    return candidate.$metadata.httpStatusCode;
  }
  return undefined;
}

function isRecoverableError(err: unknown): boolean {
  // extractInvoiceData wraps both transient API failures and terminal validation failures in
  // AiExtractionError; only the former carries a `cause` (the underlying API/network error).
  if (err instanceof AiExtractionError) {
    return err.cause !== undefined && isRecoverableError(err.cause);
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return RETRYABLE_PRISMA_CODES.has(err.code);
  }
  const status = getHttpStatus(err);
  if (status !== undefined) return RETRYABLE_HTTP_STATUS.has(status);
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && RETRYABLE_SYSTEM_CODES.has(code)) return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return RECOVERABLE_MESSAGE_PATTERN.test(message);
}

/** `${ErrorName}: message` — used both for the persisted `errorReason` and structured logs. */
function describeError(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** The subset of `GmailClient` the orchestrator needs — keeps this module easy to test. */
type IngestionGmailClient = Pick<GmailClient, 'listMessages' | 'getMessage' | 'getAttachment'>;

export interface InvoiceMonitorDeps {
  gmailClient?: IngestionGmailClient;
  attachmentStore?: AttachmentStore;
}

export interface RunSummary {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  emailsScanned: number;
  invoiceEmailsFound: number;
  invoicesProcessed: number;
  skipped: number;
  failures: number;
}

interface RunCounters {
  emailsScanned: number;
  invoiceEmailsFound: number;
  invoicesProcessed: number;
  skipped: number;
  failures: number;
}

function createCounters(): RunCounters {
  return { emailsScanned: 0, invoiceEmailsFound: 0, invoicesProcessed: 0, skipped: 0, failures: 0 };
}

function buildSummary(runId: string, startedAt: Date, counters: RunCounters): RunSummary {
  const finishedAt = new Date();
  const summary: RunSummary = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    ...counters,
  };
  logger.info(summary, 'Completed invoice ingestion run');
  return summary;
}

function getDefaultAttachmentStore(): AttachmentStore {
  return env.ATTACHMENT_STORE_DRIVER === 'local'
    ? new LocalAttachmentStore()
    : new GcsAttachmentStore();
}

/**
 * Emails received on/after this timestamp are candidates for the next run — the high-water mark
 * from the latest `SourceEmail` we've ever recorded, or "now" on a fresh install (FR-011: no
 * backfill of pre-existing mailbox history).
 */
async function resolveDiscoverySince(): Promise<Date> {
  const _latest = await prisma.sourceEmail.findFirst({
    orderBy: { receivedAt: 'desc' },
    select: { receivedAt: true },
  });
  // return _latest?.receivedAt ?? new Date();

  // First run: look back 90 days for testing purposes
  const since = new Date();
  since.setDate(since.getDate() - 90);
  logger.debug({ since: since.toISOString() }, 'Resolved discovery since');
  return since;
}

export function getHeader(payload: GmailMessagePart | undefined, name: string): string | undefined {
  return payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())
    ?.value;
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function collectPartsByMimeType(
  part: GmailMessagePart | undefined,
  mimeType: string,
  acc: string[] = [],
): string[] {
  if (!part) return acc;
  if (part.mimeType === mimeType && part.body?.data) {
    acc.push(decodeBase64Url(part.body.data));
  }
  part.parts?.forEach((child) => collectPartsByMimeType(child, mimeType, acc));
  return acc;
}

/** Prefers `text/plain`; falls back to `text/html` (tags stripped) when no plain part exists. */
export function extractBodyText(payload: GmailMessagePart | undefined): string | undefined {
  const plainParts = collectPartsByMimeType(payload, 'text/plain');
  if (plainParts.length > 0) return plainParts.join('\n\n').trim();

  const htmlParts = collectPartsByMimeType(payload, 'text/html');
  if (htmlParts.length > 0) return stripHtml(htmlParts.join('\n\n'));

  return undefined;
}

type SupportedAttachmentType = 'pdf' | 'csv';

/** FR-003: PDF and CSV are the supported attachment types for structured extraction. */
export function classifyAttachmentType(
  attachment: Pick<AttachmentMetadata, 'mimeType' | 'filename'>,
): SupportedAttachmentType | undefined {
  const mimeType = attachment.mimeType.toLowerCase();
  const filename = attachment.filename.toLowerCase();
  if (mimeType === 'application/pdf' || filename.endsWith('.pdf')) return 'pdf';
  if (mimeType === 'text/csv' || mimeType === 'application/csv' || filename.endsWith('.csv')) {
    return 'csv';
  }
  return undefined;
}

function csvToPlainText(headers: string[], rows: Record<string, string>[]): string {
  const lines = rows.map((row) => headers.map((header) => row[header] ?? '').join(','));
  return [headers.join(','), ...lines].join('\n');
}

async function extractAttachmentText(
  store: AttachmentStore,
  attachment: AttachmentMetadata,
  type: SupportedAttachmentType,
): Promise<string> {
  const data = await store.retrieve(attachment.storageRef);
  if (type === 'pdf') {
    const { text } = await extractPdfText(data);
    return text;
  }
  const { headers, rows } = extractCsvData(data);
  return csvToPlainText(headers, rows);
}

/**
 * Builds the text handed to Claude for extraction: supported attachment text when present
 * (FR-003), otherwise the email body (FR-005). Throws when neither source yields usable content,
 * which surfaces as a diagnosable `FAILED` `ProcessingHistoryEntry` rather than a silent skip.
 */
export async function buildSourceText(
  store: AttachmentStore,
  attachments: AttachmentMetadata[],
  bodyText: string | undefined,
): Promise<string> {
  const supported = attachments
    .map((attachment) => ({ attachment, type: classifyAttachmentType(attachment) }))
    .filter(
      (entry): entry is { attachment: AttachmentMetadata; type: SupportedAttachmentType } =>
        entry.type !== undefined,
    );

  if (supported.length > 0) {
    const texts = await Promise.all(
      supported.map(({ attachment, type }) => extractAttachmentText(store, attachment, type)),
    );
    return texts.join('\n\n---\n\n');
  }

  if (bodyText && bodyText.trim().length > 0) return bodyText;

  throw new Error(
    'No extractable content: no supported (PDF/CSV) attachment and no usable email body text',
  );
}

interface UpsertSourceEmailInput {
  gmailMessageId: string;
  vendorId: string | undefined;
  sender: string;
  subject: string;
  receivedAt: Date;
  bodyTextExcerpt: string | undefined;
}

async function upsertSourceEmail(input: UpsertSourceEmailInput) {
  return prisma.sourceEmail.upsert({
    where: { gmailMessageId: input.gmailMessageId },
    create: {
      gmailMessageId: input.gmailMessageId,
      vendorId: input.vendorId ?? null,
      sender: input.sender,
      subject: input.subject,
      receivedAt: input.receivedAt,
      bodyTextExcerpt: input.bodyTextExcerpt ?? null,
    },
    update: {
      vendorId: input.vendorId ?? null,
      sender: input.sender,
      subject: input.subject,
      receivedAt: input.receivedAt,
      bodyTextExcerpt: input.bodyTextExcerpt ?? null,
    },
  });
}

async function nextAttemptNumber(sourceEmailId: string): Promise<number> {
  const priorAttempts = await prisma.processingHistoryEntry.count({ where: { sourceEmailId } });
  return priorAttempts + 1;
}

interface ProcessContext {
  runId: string;
  gmailClient: IngestionGmailClient;
  attachmentStore: AttachmentStore;
  vendors: Vendor[];
}

/**
 * Evaluates one candidate email end-to-end: duplicate detection (4.1) → attachment download (4.2)
 * → content extraction (4.3) → Claude extraction (4.4) → persistence (4.5-4.7). Always writes
 * exactly one `ProcessingHistoryEntry` (4.8) for the attempt, except when the message itself can't
 * be fetched — see the caller's outer catch for that boundary case.
 */
async function processCandidateEmail(
  ctx: ProcessContext,
  candidate: CandidateEmailRef,
  counters: RunCounters,
): Promise<void> {
  const startedAt = Date.now();
  logger.info({ runId: ctx.runId, gmailMessageId: candidate.id }, 'Processing message');

  const message = await ctx.gmailClient.getMessage(candidate.id);
  const sender = getHeader(message.payload, 'From') ?? '';
  const subject = getHeader(message.payload, 'Subject') ?? '';
  const receivedAt = message.internalDate ? new Date(Number(message.internalDate)) : new Date();
  const bodyText = extractBodyText(message.payload);
  const vendor = findMatchingVendor(ctx.vendors, { sender, subject });

  // 4.1 Duplicate detection: an email already tied to an Invoice is fully processed — record the
  // re-evaluation for audit purposes and skip re-doing the work (idempotency, Principle II).
  const existing = await prisma.sourceEmail.findUnique({
    where: { gmailMessageId: message.id },
    include: { invoice: true },
  });

  if (existing?.invoice) {
    const attemptNumber = await nextAttemptNumber(existing.id);
    await prisma.processingHistoryEntry.create({
      data: {
        sourceEmailId: existing.id,
        invoiceId: existing.invoice.id,
        outcome: 'SKIPPED_DUPLICATE',
        attemptNumber,
        evaluatedAt: new Date(),
      },
    });
    counters.skipped += 1;
    logger.info(
      {
        runId: ctx.runId,
        gmailMessageId: message.id,
        vendor: vendor?.name,
        invoiceId: existing.invoice.id,
        durationMs: Date.now() - startedAt,
      },
      'Duplicate detected; skipping already-processed email',
    );
    return;
  }

  // research.md #9: the SourceEmail row is created before any extraction work, so a crash mid-run
  // can never lead to double-processing on retry.
  const sourceEmail = await upsertSourceEmail({
    gmailMessageId: message.id,
    vendorId: vendor?.id,
    sender,
    subject,
    receivedAt,
    bodyTextExcerpt: bodyText?.slice(0, 2000),
  });
  const attemptNumber = await nextAttemptNumber(sourceEmail.id);

  if (!vendor) {
    await prisma.processingHistoryEntry.create({
      data: {
        sourceEmailId: sourceEmail.id,
        outcome: 'SKIPPED_NOT_INVOICE',
        attemptNumber,
        evaluatedAt: new Date(),
      },
    });
    counters.skipped += 1;
    logger.info(
      { runId: ctx.runId, gmailMessageId: message.id },
      'Skipping email that matched no configured vendor',
    );
    return;
  }

  counters.invoiceEmailsFound += 1;
  // Narrowed copy: `vendor`'s `!vendor` guard above doesn't survive into the nested
  // `extractAndPersistInvoice` closure declared below, since TS re-widens closure-captured
  // variables to their declared type.
  const matchedVendor: Vendor = vendor;

  // Attachment download/records happen once, outside the retry loop below, so a retried
  // extraction never re-downloads or duplicates Attachment rows; they stay linked to the
  // SourceEmail (and thus available for diagnostics) even if extraction ultimately fails.
  const downloaded = await downloadMessageAttachments(
    ctx.gmailClient,
    ctx.attachmentStore,
    message.id,
    message.payload,
  );
  const attachmentRecords = await Promise.all(
    downloaded.map((attachment) =>
      prisma.attachment.create({
        data: {
          sourceEmailId: sourceEmail.id,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          storageRef: attachment.storageRef,
          sizeBytes: attachment.sizeBytes,
        },
      }),
    ),
  );

  let finalAttemptNumber = attemptNumber;

  /**
   * Extraction + persistence (Claude/Bedrock call, then the Invoice create + Attachment link)
   * retried up to MAX_PROCESSING_ATTEMPTS on recoverable failures (4.4 T037). The invoice
   * create/link pair runs inside one `$transaction` so a retried attempt can never leave a
   * half-linked invoice or violate `Invoice.sourceEmailId`'s unique constraint on retry.
   */
  async function extractAndPersistInvoice() {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_PROCESSING_ATTEMPTS; attempt += 1) {
      finalAttemptNumber = attemptNumber + attempt - 1;
      try {
        const sourceText = await buildSourceText(ctx.attachmentStore, downloaded, bodyText);
        const extracted = await extractInvoiceData({
          vendorName: matchedVendor.name,
          sourceText,
        });
        // Vendor.defaultSubscriptionType is the documented fallback hint (data-model.md) when
        // extraction itself can't determine the subscription model from the email.
        const subscriptionType =
          extracted.subscriptionType ?? matchedVendor.defaultSubscriptionType ?? undefined;

        return await prisma.$transaction(async (tx) => {
          const invoice = await tx.invoice.create({
            data: {
              sourceEmailId: sourceEmail.id,
              vendorId: matchedVendor.id,
              amount: extracted.amount,
              currency: extracted.currency,
              invoiceDate: new Date(extracted.invoiceDate),
              ...(extracted.billingPeriodStart
                ? { billingPeriodStart: new Date(extracted.billingPeriodStart) }
                : {}),
              ...(extracted.billingPeriodEnd
                ? { billingPeriodEnd: new Date(extracted.billingPeriodEnd) }
                : {}),
              ...(subscriptionType ? { subscriptionType } : {}),
              ...(extracted.lineItems ? { lineItems: extracted.lineItems } : {}),
              extractionConfidence: extracted.extractionConfidence,
            },
          });

          if (attachmentRecords.length > 0) {
            await tx.attachment.updateMany({
              where: { id: { in: attachmentRecords.map((record) => record.id) } },
              data: { invoiceId: invoice.id },
            });
          }

          return invoice;
        });
      } catch (err) {
        lastError = err;
        const attemptsRemain = attempt < MAX_PROCESSING_ATTEMPTS;
        if (!attemptsRemain || !isRecoverableError(err)) {
          throw err;
        }

        const backoffMs = RETRY_BACKOFF_MS[attempt] ?? 0;
        logger.warn(
          {
            runId: ctx.runId,
            gmailMessageId: message.id,
            vendor: matchedVendor.name,
            errorType: err instanceof Error ? err.name : typeof err,
            errorMessage: describeError(err),
            attemptNumber: finalAttemptNumber,
            backoffMs,
          },
          'Retrying recoverable failure while processing invoice email',
        );
        await prisma.processingHistoryEntry.create({
          data: {
            sourceEmailId: sourceEmail.id,
            outcome: 'RETRYING',
            attemptNumber: finalAttemptNumber,
            errorReason: describeError(err),
            evaluatedAt: new Date(),
          },
        });
        if (backoffMs > 0) await delay(backoffMs);
      }
    }
    throw lastError;
  }

  try {
    const invoice = await extractAndPersistInvoice();

    await prisma.processingHistoryEntry.create({
      data: {
        sourceEmailId: sourceEmail.id,
        invoiceId: invoice.id,
        outcome: 'PROCESSED',
        attemptNumber: finalAttemptNumber,
        evaluatedAt: new Date(),
      },
    });
    counters.invoicesProcessed += 1;
    logger.info(
      {
        runId: ctx.runId,
        gmailMessageId: message.id,
        vendor: vendor.name,
        invoiceId: invoice.id,
        attemptNumber: finalAttemptNumber,
        durationMs: Date.now() - startedAt,
      },
      'Invoice persisted',
    );
  } catch (err) {
    await prisma.processingHistoryEntry.create({
      data: {
        sourceEmailId: sourceEmail.id,
        outcome: 'FAILED',
        attemptNumber: finalAttemptNumber,
        errorReason: describeError(err),
        evaluatedAt: new Date(),
      },
    });
    counters.failures += 1;
    logger.error(
      {
        runId: ctx.runId,
        gmailMessageId: message.id,
        vendor: vendor.name,
        errorType: err instanceof Error ? err.name : typeof err,
        errorMessage: describeError(err),
        attemptNumber: finalAttemptNumber,
        durationMs: Date.now() - startedAt,
        err,
      },
      'Failed to process invoice email',
    );
  }
}

/**
 * Entry point for one subscription invoice ingestion run: discover candidate emails from the
 * configured vendor list, process each independently, and return a run summary
 * (contracts/http-api.md `POST /tasks/ingest-invoices`).
 */
export async function runInvoiceCheck(deps: InvoiceMonitorDeps = {}): Promise<RunSummary> {
  const runId = randomUUID();
  const startedAt = new Date();
  const counters = createCounters();

  logger.info({ runId }, 'Starting invoice ingestion run');

  const vendors = await loadEnabledVendors();
  if (vendors.length === 0) {
    logger.warn({ runId }, 'No enabled vendors configured; ending run with nothing to do');
    return buildSummary(runId, startedAt, counters);
  }

  const gmailClient = deps.gmailClient ?? new GmailClient();
  const attachmentStore = deps.attachmentStore ?? getDefaultAttachmentStore();

  const since = await resolveDiscoverySince();
  const candidates = await discoverCandidateEmails(gmailClient, vendors, { since });
  counters.emailsScanned = candidates.length;

  const ctx: ProcessContext = { runId, gmailClient, attachmentStore, vendors };

  for (const candidate of candidates) {
    try {
      await processCandidateEmail(ctx, candidate, counters);
    } catch (err) {
      // The message itself couldn't be fetched, so no SourceEmail exists to attach a
      // ProcessingHistoryEntry to (constitution Principle I: still count and log it loudly rather
      // than losing it silently) — per-email isolation means the run continues regardless.
      counters.failures += 1;
      logger.error(
        { runId, messageId: candidate.id, err },
        'Failed to evaluate candidate email before it could be recorded',
      );
    }
  }

  return buildSummary(runId, startedAt, counters);
}
