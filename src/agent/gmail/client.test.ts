import type { gmail_v1 } from 'googleapis';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';

interface FakeOAuth2ClientOptions {
  clientId?: string;
  clientSecret?: string;
}

const oauth2ClientInstances: FakeOAuth2Client[] = [];

class FakeOAuth2Client {
  readonly options: FakeOAuth2ClientOptions;
  credentials: Record<string, unknown> = {};

  constructor(options: FakeOAuth2ClientOptions) {
    this.options = options;
    oauth2ClientInstances.push(this);
  }

  setCredentials(credentials: Record<string, unknown>): void {
    this.credentials = credentials;
  }

  /** Mimics google-auth-library minting a fresh access token from the stored refresh token. */
  refreshAccessToken(): Promise<{ credentials: Record<string, unknown> }> {
    const refreshToken = this.credentials.refresh_token;
    if (typeof refreshToken !== 'string') {
      throw new Error('No refresh token is set.');
    }
    this.credentials = {
      ...this.credentials,
      access_token: `minted-access-token-for-${refreshToken}`,
      expiry_date: Date.now() + 3_600_000,
    };
    return Promise.resolve({ credentials: this.credentials });
  }
}

vi.mock('google-auth-library', () => ({
  OAuth2Client: FakeOAuth2Client,
}));

const gmailFactory = vi.fn();

vi.mock('googleapis', () => ({
  google: {
    gmail: (...args: unknown[]) => gmailFactory(...args) as unknown,
  },
}));

vi.mock('../../config/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    GMAIL_CLIENT_ID: 'env-client-id',
    GMAIL_CLIENT_SECRET: 'env-client-secret',
    GMAIL_REFRESH_TOKEN: 'env-refresh-token',
  },
}));

const { GmailClient } = await import('./client.js');

interface FakeGmailOverrides {
  list?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  attachmentsGet?: ReturnType<typeof vi.fn>;
}

function createFakeGmail(overrides: FakeGmailOverrides = {}) {
  return {
    users: {
      messages: {
        list: overrides.list ?? vi.fn(),
        get: overrides.get ?? vi.fn(),
        attachments: {
          get: overrides.attachmentsGet ?? vi.fn(),
        },
      },
    },
  } as unknown as gmail_v1.Gmail;
}

function makeStatusError(
  status: number,
  message = 'Gmail API error',
): Error & {
  response: { status: number };
} {
  const err = new Error(message) as Error & { response: { status: number } };
  err.response = { status };
  return err;
}

function makeCodeError(code: number, message = 'Gmail API error'): Error & { code: number } {
  const err = new Error(message) as Error & { code: number };
  err.code = code;
  return err;
}

beforeEach(() => {
  oauth2ClientInstances.length = 0;
  gmailFactory.mockReset();
  gmailFactory.mockReturnValue(createFakeGmail());
});

describe('GmailClient authentication', () => {
  it('builds an OAuth2 client from explicit config and wires it into the Gmail API client', () => {
    new GmailClient({
      clientId: 'cfg-id',
      clientSecret: 'cfg-secret',
      refreshToken: 'cfg-refresh',
    });

    expect(oauth2ClientInstances).toHaveLength(1);
    const oauthClient = oauth2ClientInstances[0]!;
    expect(oauthClient.options).toEqual({ clientId: 'cfg-id', clientSecret: 'cfg-secret' });
    expect(oauthClient.credentials).toEqual({ refresh_token: 'cfg-refresh' });
    expect(gmailFactory).toHaveBeenCalledWith({ version: 'v1', auth: oauthClient });
  });

  it('falls back to environment configuration when no explicit config is provided', () => {
    new GmailClient();

    const oauthClient = oauth2ClientInstances[0]!;
    expect(oauthClient.options).toEqual({
      clientId: 'env-client-id',
      clientSecret: 'env-client-secret',
    });
    expect(oauthClient.credentials).toEqual({ refresh_token: 'env-refresh-token' });
  });

  it('does not construct an OAuth2 client when a Gmail API client is injected', () => {
    const fakeGmail = createFakeGmail();

    new GmailClient({}, fakeGmail);

    expect(oauth2ClientInstances).toHaveLength(0);
    expect(gmailFactory).not.toHaveBeenCalled();
  });
});

describe('GmailClient token refresh', () => {
  it('mints a fresh access token from the stored refresh token', async () => {
    new GmailClient({ refreshToken: 'refresh-xyz' });

    const oauthClient = oauth2ClientInstances[0]!;
    expect(oauthClient.credentials.access_token).toBeUndefined();

    const { credentials } = await oauthClient.refreshAccessToken();

    expect(credentials.access_token).toBe('minted-access-token-for-refresh-xyz');
  });
});

describe('GmailClient.listMessages', () => {
  it('lists messages with only the required userId param by default', async () => {
    const list = vi
      .fn()
      .mockResolvedValue({
        data: { messages: [{ id: 'm1', threadId: 't1' }], resultSizeEstimate: 1 },
      });
    const client = new GmailClient({}, createFakeGmail({ list }));

    const result = await client.listMessages();

    expect(list).toHaveBeenCalledWith({ userId: 'me' });
    expect(result.messages).toEqual([{ id: 'm1', threadId: 't1' }]);
  });

  it('passes through query, pageToken, and maxResults when provided', async () => {
    const list = vi.fn().mockResolvedValue({ data: { messages: [] } });
    const client = new GmailClient({}, createFakeGmail({ list }));

    await client.listMessages({ q: 'from:vendor@example.com', pageToken: 'abc', maxResults: 25 });

    expect(list).toHaveBeenCalledWith({
      userId: 'me',
      q: 'from:vendor@example.com',
      pageToken: 'abc',
      maxResults: 25,
    });
  });

  it('throws a validation error when the response does not match the expected shape', async () => {
    const list = vi.fn().mockResolvedValue({ data: { messages: [{ id: 'm1' }] } });
    const client = new GmailClient({}, createFakeGmail({ list }));

    await expect(client.listMessages()).rejects.toBeInstanceOf(ZodError);
  });
});

describe('GmailClient.getMessage', () => {
  it('retrieves and parses a full message', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        id: 'm1',
        threadId: 't1',
        labelIds: ['INBOX'],
        snippet: 'Invoice attached',
        internalDate: '1700000000000',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [{ name: 'Subject', value: 'Invoice #123' }],
          parts: [
            {
              mimeType: 'application/pdf',
              filename: 'invoice.pdf',
              body: { attachmentId: 'att1', size: 2048 },
            },
          ],
        },
      },
    });
    const client = new GmailClient({}, createFakeGmail({ get }));

    const message = await client.getMessage('m1');

    expect(get).toHaveBeenCalledWith({ userId: 'me', id: 'm1', format: 'full' });
    expect(message.id).toBe('m1');
    expect(message.payload?.parts?.[0]?.filename).toBe('invoice.pdf');
    expect(message.payload?.parts?.[0]?.body?.attachmentId).toBe('att1');
  });

  it('throws a validation error for malformed message payloads', async () => {
    const get = vi.fn().mockResolvedValue({ data: { id: 'm1' } });
    const client = new GmailClient({}, createFakeGmail({ get }));

    await expect(client.getMessage('m1')).rejects.toBeInstanceOf(ZodError);
  });
});

describe('GmailClient.getAttachment', () => {
  it('retrieves attachment bytes', async () => {
    const attachmentsGet = vi
      .fn()
      .mockResolvedValue({ data: { size: 2048, data: 'base64data==' } });
    const client = new GmailClient({}, createFakeGmail({ attachmentsGet }));

    const attachment = await client.getAttachment('m1', 'att1');

    expect(attachmentsGet).toHaveBeenCalledWith({ userId: 'me', messageId: 'm1', id: 'att1' });
    expect(attachment).toEqual({ size: 2048, data: 'base64data==' });
  });

  it('throws a validation error for malformed attachment payloads', async () => {
    const attachmentsGet = vi.fn().mockResolvedValue({ data: { size: -1, data: 'x' } });
    const client = new GmailClient({}, createFakeGmail({ attachmentsGet }));

    await expect(client.getAttachment('m1', 'att1')).rejects.toBeInstanceOf(ZodError);
  });
});

describe('GmailClient error handling', () => {
  it('propagates non-retryable errors immediately without retrying', async () => {
    const error = makeStatusError(404, 'Not Found');
    const list = vi.fn().mockRejectedValue(error);
    const client = new GmailClient({}, createFakeGmail({ list }));

    await expect(client.listMessages()).rejects.toBe(error);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('propagates errors that carry no recognizable status code immediately', async () => {
    const error = new Error('network fell over');
    const get = vi.fn().mockRejectedValue(error);
    const client = new GmailClient({}, createFakeGmail({ get }));

    await expect(client.getMessage('m1')).rejects.toBe(error);
    expect(get).toHaveBeenCalledTimes(1);
  });
});

describe('GmailClient retry behavior', () => {
  it('retries retryable errors and succeeds once the API recovers', async () => {
    vi.useFakeTimers();
    try {
      const error503 = makeStatusError(503, 'Service Unavailable');
      const list = vi
        .fn()
        .mockRejectedValueOnce(error503)
        .mockRejectedValueOnce(error503)
        .mockResolvedValueOnce({ data: { messages: [{ id: 'm1', threadId: 't1' }] } });
      const client = new GmailClient({}, createFakeGmail({ list }));

      const resultPromise = client.listMessages();
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(list).toHaveBeenCalledTimes(3);
      expect(result.messages).toEqual([{ id: 'm1', threadId: 't1' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a status code surfaced via err.code as well as err.response.status', async () => {
    vi.useFakeTimers();
    try {
      const error429 = makeCodeError(429, 'Too Many Requests');
      const attachmentsGet = vi
        .fn()
        .mockRejectedValueOnce(error429)
        .mockResolvedValueOnce({ data: { size: 10, data: 'abc' } });
      const client = new GmailClient({}, createFakeGmail({ attachmentsGet }));

      const resultPromise = client.getAttachment('m1', 'att1');
      await vi.runAllTimersAsync();
      const result = await resultPromise;

      expect(attachmentsGet).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ size: 10, data: 'abc' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up after the maximum number of attempts and throws the last error', async () => {
    vi.useFakeTimers();
    try {
      const error500 = makeStatusError(500, 'Internal Error');
      const list = vi.fn().mockRejectedValue(error500);
      const client = new GmailClient({}, createFakeGmail({ list }));

      const resultPromise = client.listMessages();
      const expectation = expect(resultPromise).rejects.toBe(error500);
      await vi.runAllTimersAsync();
      await expectation;

      expect(list).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
