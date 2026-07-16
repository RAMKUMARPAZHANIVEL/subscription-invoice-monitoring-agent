/**
 * Gmail API client (research.md #1) — OAuth2 authentication against a single admin account,
 * scoped to `gmail.readonly`, wrapping the `messages.list`, `messages.get`, and
 * `attachments.get` calls the ingestion pipeline needs.
 *
 * Token refresh is handled by `google-auth-library`'s `OAuth2Client`, which mints a fresh
 * access token from the stored refresh token whenever the current one expires.
 */

import { OAuth2Client } from 'google-auth-library';
import { google, type gmail_v1 } from 'googleapis';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/** Least-privilege scope (research.md #1) — read-only, no label writes. */
export const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const RETRYABLE_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 500;

function getStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const withCode = err as { code?: unknown; response?: { status?: unknown } };
  const status = withCode.response?.status ?? withCode.code;
  return typeof status === 'number' ? status : undefined;
}

function isRetryable(err: unknown): boolean {
  const status = getStatusCode(err);
  return status !== undefined && RETRYABLE_STATUS_CODES.has(status);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) {
        logger.error({ err, operation, attempt }, 'Gmail API call failed');
        throw err;
      }
      const backoffMs = BASE_RETRY_DELAY_MS * 2 ** (attempt - 1);
      logger.warn({ err, operation, attempt, backoffMs }, 'Retrying transient Gmail API failure');
      await delay(backoffMs);
    }
  }
}

const MessagePartHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const MessagePartBodySchema = z.object({
  attachmentId: z.string().optional(),
  size: z.number().int().nonnegative().optional(),
  data: z.string().optional(),
});

export interface GmailMessagePart {
  partId?: string | undefined;
  mimeType?: string | undefined;
  filename?: string | undefined;
  headers?: z.infer<typeof MessagePartHeaderSchema>[] | undefined;
  body?: z.infer<typeof MessagePartBodySchema> | undefined;
  parts?: GmailMessagePart[] | undefined;
}

const MessagePartSchema: z.ZodType<GmailMessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().optional(),
    mimeType: z.string().optional(),
    filename: z.string().optional(),
    headers: z.array(MessagePartHeaderSchema).optional(),
    body: MessagePartBodySchema.optional(),
    parts: z.array(MessagePartSchema).optional(),
  }),
);

export const GmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: MessagePartSchema.optional(),
});
export type GmailMessage = z.infer<typeof GmailMessageSchema>;

export const GmailMessageListSchema = z.object({
  messages: z.array(z.object({ id: z.string(), threadId: z.string() })).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().optional(),
});
export type GmailMessageList = z.infer<typeof GmailMessageListSchema>;

export const GmailAttachmentSchema = z.object({
  size: z.number().int().nonnegative(),
  data: z.string(),
});
export type GmailAttachment = z.infer<typeof GmailAttachmentSchema>;

export interface ListMessagesParams {
  q?: string;
  pageToken?: string;
  maxResults?: number;
}

export interface GmailClientConfig {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
}

/** OAuth2 Gmail API client. Reusable across discovery/attachment-download call sites. */
export class GmailClient {
  private readonly gmail: gmail_v1.Gmail;

  /**
   * `gmail` is injectable so tests can supply a fake `gmail_v1.Gmail` against a stub HTTP
   * layer (T014) instead of hitting the real API.
   */
  constructor(config: GmailClientConfig = {}, gmail?: gmail_v1.Gmail) {
    if (gmail) {
      this.gmail = gmail;
      return;
    }

    const oauth2Client = new OAuth2Client({
      clientId: config.clientId ?? env.GMAIL_CLIENT_ID,
      clientSecret: config.clientSecret ?? env.GMAIL_CLIENT_SECRET,
    });
    oauth2Client.setCredentials({
      refresh_token: config.refreshToken ?? env.GMAIL_REFRESH_TOKEN,
    });

    this.gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  }

  async listMessages(params: ListMessagesParams = {}): Promise<GmailMessageList> {
    return withRetry('messages.list', async () => {
      const { data } = await this.gmail.users.messages.list({
        userId: 'me',
        ...(params.q !== undefined ? { q: params.q } : {}),
        ...(params.pageToken !== undefined ? { pageToken: params.pageToken } : {}),
        ...(params.maxResults !== undefined ? { maxResults: params.maxResults } : {}),
      });
      const parsed = GmailMessageListSchema.parse(data);
      logger.info(
        { query: params.q, count: parsed.messages?.length ?? 0 },
        'Listed Gmail messages',
      );
      return parsed;
    });
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    return withRetry('messages.get', async () => {
      const { data } = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
      });
      const parsed = GmailMessageSchema.parse(data);
      logger.info({ messageId }, 'Fetched Gmail message');
      return parsed;
    });
  }

  async getAttachment(messageId: string, attachmentId: string): Promise<GmailAttachment> {
    return withRetry('attachments.get', async () => {
      const { data } = await this.gmail.users.messages.attachments.get({
        userId: 'me',
        messageId,
        id: attachmentId,
      });
      const parsed = GmailAttachmentSchema.parse(data);
      logger.info({ messageId, attachmentId, sizeBytes: parsed.size }, 'Fetched Gmail attachment');
      return parsed;
    });
  }
}
